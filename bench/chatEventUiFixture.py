"""Run built app with a synthetic streaming model and an isolated temporary DB.

Usage: python3 bench/chatEventUiFixture.py REPO OUTPUT_DIR
The state.json file contains the loopback URL. SIGTERM cleans up both servers.
"""
import http.server
import json
import os
import pathlib
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

root = pathlib.Path(sys.argv[1]).resolve()
output = pathlib.Path(sys.argv[2]).resolve()
output.mkdir(parents=True, exist_ok=True)
stop = threading.Event()
signal.signal(signal.SIGTERM, lambda *_: stop.set())
signal.signal(signal.SIGINT, lambda *_: stop.set())


class Model(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"data":[{"id":"event-fixture"}]}')

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        user = next((m['content'] for m in reversed(body.get('messages', [])) if m['role'] == 'user'), '')
        if 'FAIL_FIXTURE' in user:
            self.send_response(503)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"error":{"message":"synthetic model failure"}}')
            return
        content = '<think>INTERNAL_FIXTURE</think>\n*창가로 햇살이 들어온다.*\n[이든] : "다시 만나서 반가워요."'
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream' if body.get('stream') else 'application/json')
        self.end_headers()
        if not body.get('stream'):
            self.wfile.write(json.dumps({'choices': [{'message': {'content': content}, 'finish_reason': 'stop'}]}).encode())
            return
        try:
            for chunk in [content[i:i + 3] for i in range(0, len(content), 3)]:
                event = {'choices': [{'delta': {'content': chunk}, 'finish_reason': None}]}
                self.wfile.write(('data: ' + json.dumps(event) + '\n\n').encode())
                self.wfile.flush()
                time.sleep(.15 if 'SLOW_FIXTURE' not in user else .7)
            self.wfile.write(b'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *args):
        pass


model = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Model)
threading.Thread(target=model.serve_forever, daemon=True).start()
proc = None
try:
    with tempfile.TemporaryDirectory(prefix='rpchat-event-ui-') as tmp:
        env = dict(os.environ, DATA_DIR=tmp, HOST='127.0.0.1', PORT='0', AUTH_MODE='none',
                   MODEL_BASE_URL=f'http://127.0.0.1:{model.server_port}/v1', MODEL_NAME='event-fixture',
                   RPCHAT_PROMPT_DUMP='0', RPCHAT_REQUEST_DUMP='0')
        subprocess.run(['node', 'apps/server/dist/db/cli.js', 'migrate', '--data-dir', tmp],
                       cwd=root, env=env, check=True, capture_output=True, text=True)
        with (output / 'server.log').open('w') as log:
            proc = subprocess.Popen(['node', 'apps/server/dist/index.js'], cwd=root, env=env,
                                    stdout=log, stderr=subprocess.STDOUT)
            origin = None
            for _ in range(200):
                assert proc.poll() is None, (output / 'server.log').read_text()
                match = re.search(r'Server listening at (http://127\.0\.0\.1:\d+)', (output / 'server.log').read_text())
                if match:
                    origin = match[1]
                    break
                time.sleep(.1)
            assert origin

            def post(route, body):
                req = urllib.request.Request(origin + route, data=json.dumps(body).encode(),
                                             headers={'Content-Type': 'application/json'})
                with urllib.request.urlopen(req) as response:
                    return json.load(response)

            char = post('/api/characters', {'name': '이든', 'description': '이벤트 계약 검증용 캐릭터',
                                          'first_message': '*창가에 앉아 손을 흔든다.*\n[이든] : "어서 오세요."'})
            conv = post('/api/conversations', {'characterId': char['id'], 'mode': 'chat'})
            state = dict(origin=origin, conversationId=conv['id'], dataDir=tmp, root=str(root), pid=proc.pid)
            (output / 'state.json').write_text(json.dumps(state, indent=2))
            print(json.dumps(state), flush=True)
            deadline = time.monotonic() + 3600
            while not stop.wait(1) and time.monotonic() < deadline:
                assert proc.poll() is None
finally:
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
    model.shutdown()
    model.server_close()

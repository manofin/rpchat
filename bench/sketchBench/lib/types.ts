/** Shared result types for sketchBench Task 3 concurrent harness. */

export type ChatRow = {
  i: number;
  t_sent: number;
  t_done: number;
  ttft_ms: number | null;
  total_ms: number | null;
  completion_tokens: number | null;
  status: string;
  overlapped_image: boolean;
  poll_active_start: number | null;
  poll_active_end: number | null;
};

export type ImageRow = {
  j: number;
  t_start: number;
  t_end: number;
  ok: boolean;
  http_status: number | null;
  error: string | null;
  latency_ms: number;
};

export type ActiveSample = {
  t_poll: number;
  our_active: boolean;
  active_ids: string[];
  queued: number;
  http_status: number | null;
  error: string | null;
};

export type ActiveInterval = {
  start: number;
  end: number;
};

export type CmdCapture = {
  cmd: string;
  stdout: string;
  stderr: string;
  code: number | null;
};

export type MemSnapshot = {
  label: string;
  t: number;
  swap_used_bytes: number | null;
  swap_total_bytes: number | null;
  swap_raw: string;
  vm_stat: Record<string, number>;
  vm_stat_page_size: number | null;
  pid: number | null;
  pids: number[];
  rss_kb: number | null;
  commands: {
    swap: CmdCapture;
    vm_stat: CmdCapture;
    pgrep: CmdCapture;
    ps: CmdCapture | null;
  };
};

export type MemoryBlock = {
  snapshots: MemSnapshot[];
  continuous: MemSnapshot[];
  pid_before: number | null;
  pid_after: number | null;
  pid_stable: boolean | null;
  rss_delta_kb: number | null;
  swap_delta_bytes: number | null;
  pgrep_pattern: string | null;
};

export type Percentiles = {
  p50: number | null;
  p95: number | null;
  p95_excl_max: number | null;
  n: number;
  raw: number[];
};

export type ConcurrentResult = {
  run: 'run-concurrent';
  dryrun?: boolean;
  started_at: number;
  ended_at: number;
  convId: string;
  chat: {
    rows: ChatRow[];
    n_requested: number;
    n_complete: number;
    n_error: number;
    n_overlapped: number;
    ttft_ms: {
      all: Percentiles;
      overlapped: Percentiles;
      non_overlapped: Percentiles;
    };
    tok_per_s: Percentiles;
  };
  image: {
    rows: ImageRow[];
    n_requested: number;
    n_ok: number;
    success_rate: number;
    latency_ms: Percentiles;
  };
  activePoll: {
    interval_ms: number;
    samples: ActiveSample[];
    intervals: ActiveInterval[];
  };
  memory: MemoryBlock;
  environment: {
    hostname: string;
    platform: string;
    node: string;
    serve_base: string;
    draw_things_base: string | null;
    image_interval_ms: number;
    n_chat: number;
    n_image: number;
  };
  notes: string[];
};

export type BaselineResult = {
  run: string;
  convId: string;
  rows: Array<{
    ttft_ms: number | null;
    total_ms: number | null;
    completion_tokens: number | null;
    status: string;
  }>;
  summary: {
    n_requested: number;
    n_logged: number;
    n_complete: number;
    ttft_ms: { p50: number | null; p95: number | null; raw: number[] };
    tok_per_s: { p50: number | null; raw: number[] };
    statuses: string[];
  };
};

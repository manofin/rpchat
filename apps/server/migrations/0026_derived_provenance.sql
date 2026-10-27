-- NULL retains the old record; it does not assert a public source lineage.
ALTER TABLE memories ADD COLUMN input_provenance_json TEXT
  CHECK (input_provenance_json IS NULL OR
    (json_valid(input_provenance_json) AND json_type(input_provenance_json) = 'object'));
ALTER TABLE summaries ADD COLUMN input_provenance_json TEXT
  CHECK (input_provenance_json IS NULL OR
    (json_valid(input_provenance_json) AND json_type(input_provenance_json) = 'object'));

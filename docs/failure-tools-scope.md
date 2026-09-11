
# Failure corpus tool scope

failure_record, failure_query, and failure_stats are intentionally exposed on the MCP surface only. The DSH plugin surface remains limited to verify_report because manual corpus mutation would bypass the evidence-backed verification workflow. This is an explicit surface distinction, not an accidental omission.

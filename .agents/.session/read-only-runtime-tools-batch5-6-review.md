# Read-only Runtime Tools Batch 5/6 Review

## Review target

- Range: `932cf85..e2598bc`
- Batch 5: `d9abe96 feat(agent): add windowed text file reader`
- Batch 6: `e2598bc feat(agent): add bounded workspace text search`
- Method: `$review-agent` defect-first read-only review
- Baseline verification: 26 test files / 229 tests, typecheck, lint, format check passed before review

## Findings

### [P1] Defer a trailing CR until the next decoded chunk — `packages/agent/src/tools/workspace/workspace-reader.ts:814`

`parseTextLines()` treats a trailing `\r` in a non-EOF decoded prefix as a complete CR line ending. If that `\r` is the last byte of the current read chunk and the character budget is reached at the same point, `read_file` returns it as a complete line ending and advances `nextPosition` to the next line. A following `\n` is then consumed as part of the already-skipped CRLF when the continuation call rescans the file, so concatenating pages loses the LF. Reproduced with 4,095 ASCII characters followed by CRLF and `maxOutputCharacters = 4,096`; reconstructed content differed from the source.

### [P1] Normalize read-file permission failures before Registry serialization — `packages/agent/src/tools/workspace/workspace-reader.ts:654`

`open(absolutePath, "r")` runs outside any filesystem-error normalization. An unreadable but otherwise valid workspace file therefore reaches `ToolRegistry` as an unexpected exception, producing `execution_failed` instead of `access_denied`; the raw Node error message also contains the host absolute path, violating the workspace-relative path contract. Reproduced with a mode-`000` file: the ToolResult included the temporary directory's absolute path.

### [P2] Bound read_file by the serialized envelope, not code-point count alone — `packages/agent/src/tools/builtins/read-file.ts:70`

`read_file` always asks the Reader for up to `maxOutputCharacters` code points without considering their `JSON.stringify()` size. Non-BMP characters occupy two UTF-16 code units, and escaped control characters can occupy up to six serialized characters, so a valid window can exceed `maxSerializedToolResultCharacters` and be replaced by Registry with `resource_limit` instead of returning a smaller resumable page. Reproduced with 12,001 emoji under default limits: the Reader selected 12,000 code points, but Registry returned `resource_limit`.

## Overall assessment

The Batch 5/6 boundaries, structured errors, deterministic ordering, Unicode columns, resource limits, and test coverage are otherwise coherent. All three findings affect the exact-read or security contracts and should be fixed before continuing to Batch 7.

## Required regression coverage

- A CRLF pair split at the first 4 KiB read boundary while the character budget ends on the CR.
- An unreadable `read_file` target returning `access_denied` without an absolute path in serialized output.
- A long non-BMP/control-character window returning a valid resumable success envelope within the Registry limit.

## Resolution

- Status: all findings fixed.
- Trailing non-EOF CR is held as an incomplete boundary until the next decoded chunk establishes CR or CRLF.
- `read_file` converts permission failures to `access_denied` with workspace-relative messages.
- `read_file` measures the complete success envelope and binary-searches a smaller character budget when necessary, preserving `nextPosition`.
- Added 3 regression tests; final verification: 26 test files / 232 tests, typecheck, lint, and format check passed.

# Architecture review layout file

The architecture review ([ADR-063](adr/ADR-063-architecture-review-history-and-agent-worktrees.md))
compares Subsystems, the named groups of modules whose imports of one another count as one
relationship. By default a module's Subsystem is the first directory under its source root
(`src/main/ipc/a.ts` is in `src/main`; `test/a.test.ts` is in `test`; a file at the top of
the repository is in `(repository root)`), and the scan reads the whole repository.

A repository can change both with a tracked file at the scan root:
`.hvir/architecture.json`.

```json
{
  "version": 1,
  "scope": ["src", "test"],
  "sourceRoots": ["src", "packages/app/src"],
  "subsystems": [
    { "name": "ui", "paths": ["src/renderer", "src/preload"] },
    { "name": "ui model", "paths": ["src/renderer/src/model"] }
  ]
}
```

| Key           | Required | Meaning                                                                                                                                                           |
| ------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`     | yes      | Always `1`.                                                                                                                                                       |
| `scope`       | no       | Directories or files the scan reads sources from. Leave it out to scan the whole repository; an empty list is refused. Config files are read wherever they are. |
| `sourceRoots` | no       | Directories whose first subdirectory names a Subsystem. Defaults to `["src"]`.                                                                                    |
| `subsystems`  | no       | Named Subsystems, each a list of directories or files. The most specific path wins over shorter ones and over the source-root default.                            |

Paths are relative to the scan root, use `/`, and have no leading or trailing `/`, `.` or
`..` segment. A name is 1 to 80 characters, has no surrounding spaces, is unique, and cannot
start with `external:` or `unresolved:`. A path may belong to only one Subsystem. The file
may not exceed 64 KiB.

## Which copy applies

The Current end's copy governs both ends of a Snapshot, so a comparison never regroups
modules only because the mapping changed between Baseline and Current. On a live Current end
the working-tree copy is read, tracked or not, and an edit to it makes the Snapshot stale.
Its bytes are part of the Snapshot's fingerprint.

## Refusal

The file is validated strictly. Unknown keys, invalid JSON, a wrong type, an escaping path,
a repeated name or a doubly mapped path refuse the scan with a message naming the file, the
Current end and the field, for example
`Invalid .hvir/architecture.json at working tree: "scope[0]" must be a relative path ...`.
The review never falls back to the defaults for an invalid file. Snapshot details name the
layout in effect under **Subsystems** and **Scope**.

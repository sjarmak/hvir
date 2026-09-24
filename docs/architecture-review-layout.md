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

The Current end's copy supplies `sourceRoots` and `subsystems` for both ends of a Snapshot,
so a comparison never regroups modules only because the mapping changed between Baseline and
Current. The `scope` always comes from the working-tree copy, tracked or not, for every
Snapshot including a pair of commits: the scope is a choice about what to read today, not
part of history, so narrowing it for a large repository applies to any two ends. On a live
Current end both come from the working-tree copy, and an edit to it makes the Snapshot
stale. A pair of commits is never stale (ADR-063): its Snapshot records the scope it was read
with, and a new scope takes effect on the next scan. The bytes of both copies are part of the
fingerprint.

## Size cap and choosing a scope

A scan reads at most 4,000 files and 16 MiB per end. Both limits are checked before any
content is read: a commit end from its Git listing, which carries blob sizes, and the live
working tree by measuring the listed files on the host. Above either limit the scan is
refused, never truncated. The refusal names the end, its file count, its size when known,
the scope and the cap, for example
`Architecture scan refused: working tree has 5,210 files in the whole repository, above the
cap of 4,000 files and 16 MiB. Choose a narrower scope and scan again; the review never
reads part of a scope.`
It lists the largest paths one level inside the refused scope. Ticking paths, or typing one
per line, and choosing **Save scope and scan** writes `scope` into the working-tree
`.hvir/architecture.json`, keeping every other key, and scans again. Saving the whole
repository removes the key, and writes nothing when there is no file yet.

## Refusal

The file is validated strictly. Unknown keys, invalid JSON, a wrong type, an escaping path,
a repeated name or a doubly mapped path refuse the scan with a message naming the file, the
Current end and the field, for example
`Invalid .hvir/architecture.json at working tree: "scope[0]" must be a relative path ...`.
The review never falls back to the defaults for an invalid file. Snapshot details name the
layout in effect under **Subsystems** and **Scope**.

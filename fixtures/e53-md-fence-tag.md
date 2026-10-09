# E53: in an `.md` host, only fences tagged `meant` are model content.

Prose around the fences, the way a README or design note reads. The tagged fence below is extracted and checked (its plant must fire); the `bash` fence and the untagged fence are prose — if extraction wrongly grabbed either, their contents would raise unplanted `P/unknown-statement` errors and fail the harness.

```meant
domain fencehost
  "E53 fixture: the tagged fence is extracted; its sibling fences are not."
  mode model-first
  state-of-record "in-memory"

concept Widget
  "A minimal concept."
  field label: string

shape Ghost of Phantom  # EXPECT: V2
  where label = "x"
```

```bash
git clone https://example.com/repo.git
```

```
echo untagged fences are prose too
```

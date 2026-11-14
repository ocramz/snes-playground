## Conventions

**Addresses.** Always write SNES addresses as `$BB:AAAA` with the colon
(`$9A:8000`), and file offsets as `0x`-prefixed hex (`0x0D0000`). Never write a
bare number. When a finding is location-specific, give both:
`$95:8000 (0x0A8000)`.

**Labels.** `snake_case` with a kind prefix: `sub_` routine, `loc_` jump target
within a routine, `dat_` data blob, `tbl_` table, `ptr_` pointer table, `gfx_`
graphics, `pal_` palette, `mus_` music, `ram_` a WRAM location. Prefer
meaning to address —
`sub_decompress_tiles`, not `sub_9A8000`. Use the address form only as a
placeholder until the purpose is known.

**`symbols.tsv`** — tab-separated, one symbol per line, header row, sorted by
`snes_addr`. Tabs rather than commas because comments contain commas
constantly. Columns:

```
snes_addr	file_offset	type	name	size	comment
```

`type` is one of `code`, `data`, `gfx`, `music`, `ptr`, `ram`, `reg`, `tbl`. `size` is
decimal bytes or `-` when unknown. `file_offset` is redundant with `snes_addr`
but present so the file is greppable by either address form — keep the two
consistent.
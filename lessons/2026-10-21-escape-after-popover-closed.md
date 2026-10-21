# Esc swallowed by a panel that had already closed (2026-10-21)

The Technical details panel is a `popover="auto"`. Its Esc listener (capture phase,
`stopPropagation`) was removed only after React ran the popover's `toggle` handler.
`toggle` fires as a separate task, so a second Esc pressed right after the first one
still hit the old listener: the panel was already closed, and the Changes sheet behind
it never saw the key. The UI test "a change says who made it" failed now and then on
CI (three threads saw it) and passed on re-run.

| Mistake | Rule now |
| --- | --- |
| A key listener trusted React state to know whether its layer was open. | A layer's Esc handler checks the DOM (`:popover-open`, `[open]`) before it stops the event. |
| A flaky UI test was re-run instead of read. | A UI test that fails once and passes on re-run gets its cause found in the next PR that touches the page. |

"""DeepSeek Harness (DSH) hook payload adapter.

DSH has no host-level hook-file installer: its plugins are cordis packages, and
this repository's DSH integration owns its own wiring rather than asking
``bm hook install`` to write a config file. The ``integrations/dsh`` plugin calls
``bm hook`` with a payload it constructs, so the dialect below is ours to define
and is stated here as the contract:

  session-start: cwd, session_id, trigger (startup|resume|compact), model
  pre-compact:   cwd, session_id, trigger (pressure|manual|settled), model,
                 turns (optional [{role, text}]), started (optional ISO)

DSH persists an event-sourced session log rather than a Claude-shaped transcript,
so the adapter leaves ``transcript_path`` empty.

``settled`` is the per-turn capture: the plugin reports the conversation after each
turn so a durable note exists before any compaction, and it carries the accumulated
``turns`` plus the session's own ``started``. It is not a compaction, so the core
neither treats it as one nor records a compaction envelope for it.

``pressure`` and ``manual`` come from ``compaction/start``, which the harness
publishes to session-event observers it never awaits, leaving no window in which a
graph note could be written durably (see ``_pre_compact`` in the hook core). Those
two record a lifecycle envelope only; the checkpoint is authored by the resumed
agent instead.
"""

from __future__ import annotations

from basic_memory.hooks.adapters.base import HarnessAdapter, HookPayload, NormalizedHookEvent

SOURCE = "dsh"


def normalize(event: str, payload: HookPayload) -> NormalizedHookEvent:
    """Normalize a DSH hook payload into the shared event shape."""
    trigger = payload.get("trigger") or payload.get("source")
    model = payload.get("model")
    return NormalizedHookEvent(
        source=SOURCE,
        event=event,
        session_id=str(payload.get("session_id") or ""),
        turn_id=None,
        cwd=str(payload.get("cwd") or ""),
        transcript_path="",
        trigger=str(trigger) if trigger else None,
        model=str(model) if model else None,
    )


ADAPTER = HarnessAdapter(source=SOURCE, normalize=normalize)

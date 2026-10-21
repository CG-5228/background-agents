"""Pure projection of a prompt's native sub-agents onto the bridge's ``task`` contract.

Native sub-agents (the ``collaboration`` tools) run on their own threads and
turns. The parent thread announces each one with a ``subAgentActivity`` item;
the sub-agent's own frames carry only its thread id, and its turns name the
prompt's turn as ``rootTurnId``. Each sub-agent becomes one ``task`` tool call
under the prompt's message, its tool calls nest under that task, and each of its
turns reports token usage as a subtask step. Its assistant text becomes the
task's result instead of being streamed.

Only one level is supported, matching the timeline: a sub-agent's own
sub-agents are refused, and their turns are reported for interruption.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .events import (
    MAX_ASSISTANT_TEXT_CHARS,
    TOKEN_FIELDS,
    failure_message,
    project_usage,
    tool_call_event,
)

SUBAGENT_INTERRUPTED_MESSAGE = "Sub-agent interrupted"


def _zero_usage() -> dict[str, int]:
    return dict.fromkeys(TOKEN_FIELDS, 0)


@dataclass
class _Subagent:
    thread_id: str
    task_call_id: str
    args: dict[str, Any]
    model: str
    # Cumulative native usage, and whether it can serve as the next turn's baseline.
    total: dict[str, int]
    total_known: bool
    # Announced as started, but its first turn has not started yet.
    pending: bool = False
    status: str = "running"
    output: str = ""
    turn_id: str | None = None
    text: str = ""
    error: Any = None
    baseline: dict[str, int] = field(default_factory=_zero_usage)
    baseline_known: bool = False
    usage_valid: bool = True
    tokens: dict[str, Any] | None = None


class CodexSubagents:
    def __init__(
        self,
        message_id: str,
        thread_id: str,
        turn_id: str,
        model: str,
        totals: dict[str, dict[str, int]],
    ) -> None:
        self.message_id, self.thread_id, self.turn_id = message_id, thread_id, turn_id
        self.model = model
        # Cumulative usage per sub-agent thread, owned by the harness so that a
        # sub-agent resumed by a later prompt is billed only for new work. Kept
        # current in place; a thread without an entry has an unknown baseline.
        self._totals = totals
        self._subagents: dict[str, _Subagent] = {}
        # Running turns rooted at this prompt's turn, by thread.
        self._turns: dict[str, str] = {}
        self._refused: set[str] = set()
        self._interrupts: list[tuple[str, str]] = []
        self._stopping = False

    @property
    def busy(self) -> bool:
        """Whether descendant work rooted at this prompt is announced or running."""
        return bool(self._turns) or any(s.pending for s in self._subagents.values())

    def owns(self, thread_id: Any, turn_id: Any) -> bool:
        """Whether a host tool call comes from a projected sub-agent's running turn."""
        return (
            isinstance(thread_id, str)
            and thread_id in self._subagents
            and isinstance(turn_id, str)
            and self._turns.get(thread_id) == turn_id
        )

    def stop(self) -> list[tuple[str, str]]:
        """Running descendant turns to interrupt. Any turn that starts later is reported too."""
        self._stopping = True
        return list(self._turns.items())

    def take_interrupts(self) -> list[tuple[str, str]]:
        """Refused (or post-stop) turns to interrupt, each reported once."""
        interrupts, self._interrupts = self._interrupts, []
        return interrupts

    def accept(self, frame: dict[str, Any]) -> list[dict[str, Any]]:
        method, params = frame.get("method"), frame.get("params")
        if not isinstance(params, dict) or not isinstance(params.get("threadId"), str):
            return []
        thread_id = params["threadId"]
        item = params.get("item") if isinstance(params.get("item"), dict) else {}
        if method in {"item/started", "item/completed"} and item.get("type") == "subAgentActivity":
            return self._activity(thread_id, params.get("turnId"), item)
        if thread_id == self.thread_id:
            return []
        turn = params.get("turn") if isinstance(params.get("turn"), dict) else {}
        if method == "turn/started":
            return self._turn_started(thread_id, turn)
        if method == "turn/completed":
            return self._turn_completed(thread_id, turn)
        subagent = self._subagents.get(thread_id)
        if subagent is None or params.get("turnId") != subagent.turn_id:
            return []
        if method == "thread/tokenUsage/updated":
            return self._usage(subagent, params.get("tokenUsage"))
        if method == "error":
            # The terminal ``turn/completed`` reports the failure.
            if params.get("willRetry") is not True and isinstance(params.get("error"), dict):
                subagent.error = params["error"]
            return []
        if method not in {"item/started", "item/completed"}:
            return []
        if item.get("type") == "agentMessage":
            if method == "item/completed":
                subagent.text = str(item.get("text", ""))[:MAX_ASSISTANT_TEXT_CHARS]
            return []
        event = tool_call_event(method, item, self.message_id, subagent.turn_id)
        return [self._nested(subagent, event)] if event else []

    def _activity(self, thread_id: str, turn_id: Any, item: dict[str, Any]) -> list[dict[str, Any]]:
        agent_thread_id, kind = item.get("agentThreadId"), item.get("kind")
        if not isinstance(agent_thread_id, str) or not agent_thread_id:
            return []
        if thread_id != self.thread_id:
            if thread_id in self._subagents and kind == "started":
                self._refuse(agent_thread_id)
            return []
        # Completion is read from the sub-agent's own turn; a re-tasked
        # sub-agent of an earlier prompt is announced as ``interacted``.
        if (
            turn_id != self.turn_id
            or kind not in {"started", "interacted"}
            or agent_thread_id in self._subagents
        ):
            return []
        path = item.get("agentPath")
        path = path if isinstance(path, str) and path.strip("/") else agent_thread_id
        model = item.get("model")
        known = self._totals.get(agent_thread_id)
        subagent = _Subagent(
            thread_id=agent_thread_id,
            task_call_id=f"codex:{self.turn_id}:agent:{agent_thread_id}",
            args={"description": path.rstrip("/").rsplit("/", 1)[-1], "task_id": path},
            model=model if isinstance(model, str) and model else self.model,
            # A newly spawned thread starts from zero usage.
            total=_zero_usage() if kind == "started" else dict(known or _zero_usage()),
            total_known=kind == "started" or known is not None,
            # Spawning always starts the sub-agent's first turn.
            pending=kind == "started" and agent_thread_id not in self._turns,
        )
        self._subagents[agent_thread_id] = subagent
        if kind == "started":
            self._totals[agent_thread_id] = dict(subagent.total)
        if agent_thread_id in self._turns:
            # The sub-agent's turn was reported before its announcement.
            return self._begin(subagent, self._turns[agent_thread_id])
        # A message to an idle sub-agent need not start a turn: its task row
        # appears only when it does.
        return [self._task(subagent)] if subagent.pending else []

    def _refuse(self, thread_id: str) -> None:
        if thread_id in self._refused:
            return
        self._refused.add(thread_id)
        if thread_id in self._turns:
            self._interrupts.append((thread_id, self._turns[thread_id]))

    def _turn_started(self, thread_id: str, turn: dict[str, Any]) -> list[dict[str, Any]]:
        turn_id = turn.get("id")
        if not isinstance(turn_id, str) or not turn_id:
            return []
        subagent = self._subagents.get(thread_id)
        if (
            subagent is None
            and thread_id not in self._refused
            and turn.get("rootTurnId") != self.turn_id
        ):
            return []
        self._turns[thread_id] = turn_id
        if self._stopping or thread_id in self._refused:
            self._interrupts.append((thread_id, turn_id))
        # A descendant not yet announced still counts as running work.
        return self._begin(subagent, turn_id) if subagent is not None else []

    def _begin(self, subagent: _Subagent, turn_id: str) -> list[dict[str, Any]]:
        subagent.pending = False
        subagent.turn_id = turn_id
        subagent.status = "running"
        subagent.text = ""
        subagent.error = None
        subagent.baseline = dict(subagent.total)
        subagent.baseline_known = subagent.total_known
        subagent.usage_valid = True
        subagent.tokens = None
        return [self._task(subagent), self._step(subagent, "step_start")]

    def _turn_completed(self, thread_id: str, turn: dict[str, Any]) -> list[dict[str, Any]]:
        turn_id = turn.get("id")
        if not isinstance(turn_id, str) or self._turns.get(thread_id) != turn_id:
            return []
        del self._turns[thread_id]
        subagent = self._subagents.get(thread_id)
        if subagent is None or subagent.turn_id != turn_id:
            return []
        status = turn.get("status")
        if status == "completed":
            subagent.status, subagent.output = "completed", subagent.text
        else:
            # Native work may have outrun the last observed total.
            self._distrust(subagent)
            subagent.status = "error"
            if status == "interrupted":
                subagent.output = subagent.text or SUBAGENT_INTERRUPTED_MESSAGE
            else:
                error = turn.get("error")
                subagent.output = failure_message(
                    error if isinstance(error, dict) else subagent.error
                )
        return [
            self._step(subagent, "step_finish", reason=status if isinstance(status, str) else None),
            self._task(subagent),
        ]

    def _usage(self, subagent: _Subagent, usage: Any) -> list[dict[str, Any]]:
        if not subagent.usage_valid:
            return []
        total, tokens = project_usage(
            usage, subagent.baseline, subagent.total, baseline_known=subagent.baseline_known
        )
        if total is None:
            subagent.usage_valid = False
            subagent.tokens = None
            self._distrust(subagent)
        else:
            subagent.total, subagent.total_known = total, True
            self._totals[subagent.thread_id] = total
            subagent.tokens = tokens
        return [self._step(subagent, "step_finish")]

    def _distrust(self, subagent: _Subagent) -> None:
        subagent.total_known = False
        self._totals.pop(subagent.thread_id, None)

    def _task(self, subagent: _Subagent) -> dict[str, Any]:
        return {
            "type": "tool_call",
            "messageId": self.message_id,
            "callId": subagent.task_call_id,
            "tool": "task",
            "args": subagent.args,
            "status": subagent.status,
            "output": subagent.output,
            "childSessionId": subagent.thread_id,
        }

    def _step(self, subagent: _Subagent, kind: str, *, reason: str | None = None) -> dict[str, Any]:
        event: dict[str, Any] = {
            "type": kind,
            "messageId": self.message_id,
            "stepId": f"codex:{subagent.thread_id}:{subagent.turn_id}",
            "model": f"openai/{subagent.model}",
        }
        if kind == "step_finish":
            if subagent.tokens is not None:
                event["tokens"] = subagent.tokens
            # Native turn events report tokens, not dollar costs.
            event.update(cost=0, messageCostUsd=0, reason=reason or "unknown")
        return self._nested(subagent, event)

    def _nested(self, subagent: _Subagent, event: dict[str, Any]) -> dict[str, Any]:
        event.update(
            isSubtask=True,
            taskCallId=subagent.task_call_id,
            childSessionId=subagent.thread_id,
        )
        return event

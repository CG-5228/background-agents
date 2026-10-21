from sandbox_runtime.harness.codex.subagents import SUBAGENT_INTERRUPTED_MESSAGE, CodexSubagents

PARENT, TURN, CHILD = "parent-thread", "parent-turn", "child-thread"
TASK = f"codex:{TURN}:agent:{CHILD}"


def build(totals=None):
    return CodexSubagents("m", PARENT, TURN, "gpt-6.1-sol", {} if totals is None else totals)


def activity(kind, *, thread=PARENT, turn=TURN, agent=CHILD, path="/root/review_auth", model=None):
    return {
        "method": "item/started",
        "params": {
            "threadId": thread,
            "turnId": turn,
            "item": {
                "type": "subAgentActivity",
                "id": f"{kind}-{agent}",
                "kind": kind,
                "agentThreadId": agent,
                "agentPath": path,
                "model": model,
            },
        },
    }


def turn_started(turn, *, thread=CHILD, root=TURN):
    return {
        "method": "turn/started",
        "params": {"threadId": thread, "turn": {"id": turn, "rootTurnId": root}},
    }


def turn_completed(turn, status="completed", *, thread=CHILD, error=None):
    return {
        "method": "turn/completed",
        "params": {"threadId": thread, "turn": {"id": turn, "status": status, "error": error}},
    }


def item(method, value, *, turn="child-turn", thread=CHILD):
    return {"method": method, "params": {"threadId": thread, "turnId": turn, "item": value}}


def usage(input_tokens, output_tokens, *, turn="child-turn", thread=CHILD):
    return {
        "method": "thread/tokenUsage/updated",
        "params": {
            "threadId": thread,
            "turnId": turn,
            "tokenUsage": {
                "total": {
                    "inputTokens": input_tokens,
                    "cachedInputTokens": 0,
                    "outputTokens": output_tokens,
                    "reasoningOutputTokens": 0,
                    "totalTokens": input_tokens + output_tokens,
                }
            },
        },
    }


def tasks(events):
    return [e for e in events if e["type"] == "tool_call" and e["tool"] == "task"]


def test_spawned_subagent_is_a_task_whose_activity_nests_under_it():
    subagents = build()
    spawned = subagents.accept(activity("started", model="gpt-6-luna"))
    assert spawned == [
        {
            "type": "tool_call",
            "messageId": "m",
            "callId": TASK,
            "tool": "task",
            "args": {"description": "review_auth", "task_id": "/root/review_auth"},
            "status": "running",
            "output": "",
            "childSessionId": CHILD,
        }
    ]
    # The repeated item/completed for the same announcement is not a second task.
    assert subagents.accept({**activity("started"), "method": "item/completed"}) == []
    assert subagents.busy

    started = subagents.accept(turn_started("child-turn"))
    assert started[1] == {
        "type": "step_start",
        "messageId": "m",
        "stepId": f"codex:{CHILD}:child-turn",
        "model": "openai/gpt-6-luna",
        "isSubtask": True,
        "taskCallId": TASK,
        "childSessionId": CHILD,
    }
    command = {"type": "commandExecution", "id": "c1", "command": "pytest", "status": "completed"}
    [tool] = subagents.accept(item("item/completed", command))
    assert tool["tool"] == "bash"
    assert tool["callId"] == "codex:child-turn:c1"
    assert (tool["isSubtask"], tool["taskCallId"], tool["childSessionId"]) == (True, TASK, CHILD)

    # Sub-agent text is the task result, never streamed.
    message = {"type": "agentMessage", "id": "a1", "text": "Auth is fine."}
    assert subagents.accept(item("item/completed", message)) == []
    assert subagents.accept(item("item/agentMessage/delta", {})) == []

    finished = subagents.accept(turn_completed("child-turn"))
    assert finished[0]["type"] == "step_finish"
    assert finished[0]["reason"] == "completed"
    assert tasks(finished)[0]["status"] == "completed"
    assert tasks(finished)[0]["output"] == "Auth is fine."
    assert not subagents.busy


def test_each_subagent_turn_reports_its_own_usage_as_a_subtask_step():
    totals = {}
    subagents = build(totals)
    subagents.accept(activity("started"))
    subagents.accept(turn_started("child-turn"))
    [step] = subagents.accept(usage(100, 10))
    assert step["tokens"]["total"] == 110
    assert step["isSubtask"] and step["taskCallId"] == TASK
    subagents.accept(turn_completed("child-turn"))
    assert totals[CHILD]["totalTokens"] == 110

    # Re-tasked within the prompt: the next turn bills only its own work.
    subagents.accept(turn_started("child-turn-2"))
    [step] = subagents.accept(usage(250, 20, turn="child-turn-2"))
    assert step["stepId"] == f"codex:{CHILD}:child-turn-2"
    assert step["tokens"]["total"] == 160


def test_subagent_resumed_by_a_later_prompt_is_billed_from_its_known_total():
    totals = {}
    first = build(totals)
    first.accept(activity("started"))
    first.accept(turn_started("child-turn"))
    first.accept(usage(100, 10))
    first.accept(turn_completed("child-turn"))

    later = CodexSubagents("m2", PARENT, "turn-2", "gpt-6.1-sol", totals)
    # A message to an idle sub-agent shows a task only once it starts a turn,
    # but the prompt waits to learn whether it does.
    assert later.accept(activity("interacted", turn="turn-2")) == []
    assert later.busy and later.awaiting_interactions
    started = later.accept(turn_started("child-turn-2", root="turn-2"))
    assert tasks(started)[0]["callId"] == f"codex:turn-2:agent:{CHILD}"
    [step] = later.accept(usage(130, 15, turn="child-turn-2"))
    assert step["messageId"] == "m2"
    assert step["tokens"]["total"] == 35


def test_unknown_baseline_is_re_established_instead_of_billed():
    subagents = build({})
    subagents.accept(activity("interacted"))
    subagents.accept(turn_started("child-turn"))
    [step] = subagents.accept(usage(500, 50))
    assert "tokens" not in step


def test_regressing_usage_is_distrusted_for_the_turn_and_later_prompts():
    totals = {}
    subagents = build(totals)
    subagents.accept(activity("started"))
    subagents.accept(turn_started("child-turn"))
    subagents.accept(usage(100, 10))
    [step] = subagents.accept(usage(50, 5))
    assert "tokens" not in step
    assert subagents.accept(usage(200, 10)) == []
    assert CHILD not in totals


def test_failed_and_interrupted_subagents_report_errors_and_distrust_usage():
    totals = {}
    subagents = build(totals)
    subagents.accept(activity("started"))
    subagents.accept(turn_started("child-turn"))
    subagents.accept(usage(100, 10))
    failed = subagents.accept(
        turn_completed("child-turn", "failed", error={"codexErrorInfo": "usageLimitExceeded"})
    )
    task = tasks(failed)[0]
    assert task["status"] == "error"
    assert "usage limit" in task["output"]
    assert CHILD not in totals

    subagents.accept(turn_started("child-turn-2"))
    task = tasks(subagents.accept(turn_completed("child-turn-2", "interrupted")))[0]
    assert (task["status"], task["output"]) == ("error", SUBAGENT_INTERRUPTED_MESSAGE)


def test_subagent_activity_of_other_prompts_and_threads_is_ignored():
    subagents = build()
    assert subagents.accept(activity("started", turn="older-turn")) == []
    assert subagents.accept(item("item/completed", {"type": "commandExecution", "id": "x"})) == []
    assert subagents.accept(turn_started("other", thread="stranger", root="elsewhere")) == []
    assert not subagents.busy
    # Parent-thread frames belong to CodexTurnEvents.
    assert subagents.accept(turn_completed(TURN, thread=PARENT)) == []


def test_tool_ownership_requires_the_subagents_running_turn():
    subagents = build()
    assert not subagents.owns(CHILD, "child-turn")
    subagents.accept(activity("started"))
    subagents.accept(turn_started("child-turn"))
    assert subagents.owns(CHILD, "child-turn")
    assert not subagents.owns(CHILD, "other-turn")
    assert not subagents.owns({"unhashable": True}, "child-turn")
    subagents.accept(turn_completed("child-turn"))
    assert not subagents.owns(CHILD, "child-turn")


def test_grandchildren_are_refused_and_their_turns_reported_for_interruption():
    subagents = build()
    subagents.accept(activity("started"))
    subagents.accept(turn_started("child-turn"))
    refusal = activity("started", thread=CHILD, turn="child-turn", agent="grandchild")
    assert subagents.accept(refusal) == []
    assert subagents.accept(turn_started("grand-turn", thread="grandchild")) == []
    assert subagents.take_interrupts() == [("grandchild", "grand-turn")]
    assert subagents.take_interrupts() == []
    # Its activity is not projected, but it is running work until it ends.
    assert (
        subagents.accept(
            item("item/completed", {"type": "commandExecution", "id": "g"}, thread="grandchild")
        )
        == []
    )
    subagents.accept(turn_completed("child-turn"))
    assert subagents.busy
    subagents.accept(turn_completed("grand-turn", "interrupted", thread="grandchild"))
    assert not subagents.busy


def test_refusal_after_the_grandchild_turn_started_still_interrupts_it():
    subagents = build()
    subagents.accept(activity("started"))
    subagents.accept(turn_started("child-turn"))
    subagents.accept(turn_started("grand-turn", thread="grandchild"))
    subagents.accept(activity("started", thread=CHILD, turn="child-turn", agent="grandchild"))
    assert subagents.take_interrupts() == [("grandchild", "grand-turn")]


def test_turn_reported_before_its_announcement_is_projected():
    subagents = build()
    assert subagents.accept(turn_started("child-turn")) == []
    assert subagents.busy
    assert not subagents.owns(CHILD, "child-turn")
    events = subagents.accept(activity("started"))
    assert [e["type"] for e in events] == ["tool_call", "tool_call", "step_start"]
    assert subagents.owns(CHILD, "child-turn")


def test_turn_finished_before_its_announcement_settles_and_is_projected():
    subagents = build()
    command = {"type": "commandExecution", "id": "c1", "command": "ls", "status": "completed"}
    message = {"type": "agentMessage", "id": "a1", "text": "Done."}
    for frame in (
        turn_started("child-turn"),
        item("item/completed", command),
        item("item/completed", message),
        usage(100, 10),
        turn_completed("child-turn"),
    ):
        assert subagents.accept(frame) == []
    assert not subagents.busy
    events = subagents.accept(activity("started"))
    assert not subagents.busy
    task = tasks(events)[-1]
    assert (task["status"], task["output"]) == ("completed", "Done.")
    [tool] = [e for e in events if e["type"] == "tool_call" and e["tool"] == "bash"]
    assert tool["taskCallId"] == TASK
    assert [e for e in events if e["type"] == "step_finish"][-1]["reason"] == "completed"


def test_turn_rooted_at_another_prompt_is_not_owned_or_projected():
    subagents = build()
    subagents.accept(activity("started"))
    subagents.accept(turn_started("child-turn"))
    subagents.accept(turn_completed("child-turn"))
    assert subagents.accept(turn_started("foreign-turn", root="other-root")) == []
    assert not subagents.owns(CHILD, "foreign-turn")
    assert not subagents.busy
    command = {"type": "commandExecution", "id": "c2"}
    assert subagents.accept(item("item/completed", command, turn="foreign-turn")) == []


def test_message_to_an_idle_subagent_waits_for_the_turn_it_may_start():
    subagents = build()
    subagents.accept(activity("started"))
    subagents.accept(turn_started("child-turn"))
    subagents.accept(turn_completed("child-turn"))
    # Re-tasked within the prompt; its turn has not been reported yet.
    subagents.accept(activity("interacted"))
    assert subagents.busy and subagents.awaiting_interactions
    started = subagents.accept(turn_started("child-turn-2"))
    assert tasks(started)[0]["status"] == "running"
    assert subagents.busy and not subagents.awaiting_interactions
    subagents.accept(turn_completed("child-turn-2"))
    assert not subagents.busy

    # A message that starts no turn settles once interactions expire.
    subagents.accept(activity("interacted"))
    subagents.expire_interactions()
    assert not subagents.busy


def test_unannounced_frames_of_a_refused_descendant_are_dropped():
    subagents = build()
    subagents.accept(activity("started"))
    subagents.accept(turn_started("child-turn"))
    subagents.accept(turn_started("grand-turn", thread="grandchild"))
    subagents.accept(
        item("item/completed", {"type": "commandExecution", "id": "g"}, thread="grandchild")
    )
    subagents.accept(activity("started", thread=CHILD, turn="child-turn", agent="grandchild"))
    assert subagents._unannounced == {}
    assert subagents._unannounced_frames == 0


def test_stop_reports_running_turns_and_any_that_start_later():
    subagents = build()
    subagents.accept(activity("started"))
    subagents.accept(turn_started("child-turn"))
    assert subagents.stop() == [(CHILD, "child-turn")]
    subagents.accept(activity("started", agent="late", path="/root/late"))
    subagents.accept(turn_started("late-turn", thread="late"))
    assert subagents.take_interrupts() == [("late", "late-turn")]

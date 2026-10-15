"""A replacement runtime must put durable conversation text into its first turn."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime.bridge import AgentBridge
from tests.conftest import ScriptedHarness


@pytest.mark.parametrize("saved_id", [None, "vendor-session-deleted"])
async def test_replacement_restores_prior_decisions_to_model_prompt(tmp_path, saved_id):
    harness = ScriptedHarness(session_id=None)
    bridge = make_bridge(tmp_path, harness)
    if saved_id:
        bridge.session_id_file.write_text(saved_id)
        harness.resume_session = AsyncMock(return_value=False)
    await bridge._load_session_id()

    result = await bridge._handle_prompt(command())

    assert result["success"] is True
    text = harness.prompts[0].text
    assert "Use approach X; do not use Y." in text
    assert "I will implement X in parser.py." in text
    assert text.endswith("Continue with the approach we agreed on.")
    warnings = [call.args[0] for call in bridge._send_event.call_args_list]
    assert any(
        event["type"] == "warning" and "uncommitted" in event["message"] for event in warnings
    )

    await bridge._handle_prompt({**command(), "messageId": "next", "content": "Now test it."})
    assert harness.prompts[1].text == "Now test it."


async def test_resumed_vendor_session_keeps_native_history(tmp_path):
    harness = ScriptedHarness(session_id=None)
    bridge = make_bridge(tmp_path, harness)
    bridge.session_id_file.write_text("existing-session")
    await bridge._load_session_id()

    await bridge._handle_prompt(command())

    assert harness.prompts[0].text == command()["content"]
    assert not any(call.args[0]["type"] == "warning" for call in bridge._send_event.call_args_list)


async def test_new_conversation_without_history_preserves_prompt(tmp_path):
    harness = ScriptedHarness(session_id=None)
    bridge = make_bridge(tmp_path, harness)

    await bridge._handle_prompt(
        {**command(), "recoveryContext": {"messages": [], "truncated": False}}
    )

    assert harness.prompts[0].text == command()["content"]
    assert not any(call.args[0]["type"] == "warning" for call in bridge._send_event.call_args_list)


async def test_truncated_recovery_is_visible_to_model_and_user(tmp_path):
    harness = ScriptedHarness(session_id=None)
    bridge = make_bridge(tmp_path, harness)
    cmd = command()
    cmd["recoveryContext"]["truncated"] = True

    await bridge._handle_prompt(cmd)

    assert "truncated" in harness.prompts[0].text.lower()
    assert any(
        call.args[0]["type"] == "warning" and "truncated" in call.args[0]["message"].lower()
        for call in bridge._send_event.call_args_list
    )


def make_bridge(tmp_path, harness):
    async def reply(message_id, _text):
        yield {"type": "token", "messageId": message_id, "content": "Continuing."}

    harness.stream = reply
    bridge = AgentBridge(
        sandbox_id="replacement",
        session_id="same-session",
        control_plane_url="https://control.example.com",
        auth_token="test",
        harness=harness,
    )
    bridge.log = MagicMock()
    bridge._configure_git_identity = AsyncMock()
    bridge._send_event = AsyncMock(return_value=True)
    bridge.session_id_file = tmp_path / "agent-session-id"
    bridge.legacy_session_id_file = tmp_path / "opencode-session-id"
    return bridge


def command():
    return {
        "type": "prompt",
        "messageId": "follow-up",
        "content": "Continue with the approach we agreed on.",
        "author": {"userId": "test", "gitIdentity": {"mode": "agent-only"}},
        "recoveryContext": {
            "messages": [
                {"role": "user", "content": "Use approach X; do not use Y."},
                {"role": "assistant", "content": "I will implement X in parser.py."},
            ],
            "truncated": False,
        },
    }

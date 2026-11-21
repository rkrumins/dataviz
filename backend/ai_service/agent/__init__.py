"""The assistant: grounding, tools, playbooks and the turn loop.

``loop.run_turn`` answers one message. It assembles what the model needs to
know (``grounding``), lets it call typed tools (``tools``) that read the
platform as the person asking (``platform_client``), runs deterministic
playbooks for the questions that matter most (``impact``, ``views``,
``concepts``), and streams what happens as events (``events``).
"""

---
name: hades
description: Delegate and supervise Hades work from this conversation.
---

Use the hades_delegate tool with concrete instructions and a fresh requestId. Use the same requestId only when retrying an uncertain response. Save the returned id and inspect status. Continue existing work with a fresh message requestId; never create duplicate work to get progress. Stop with cancel when requested.

This plugin connects to the user's local Hades app. It does not change the host application's default browser or grant remote cloud access to localhost. Browser tasks use the existing paired Hades Browser and its granted page access. Provider credentials and any pending tool approvals stay inside Hades. Never claim task acceptance is successful execution; inspect actual output and verification evidence.

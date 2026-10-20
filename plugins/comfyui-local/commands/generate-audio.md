---
description: Generate audio (music, speech or sound effects) on your ComfyUI
---

Generate audio on the user's ComfyUI server based on their description: $ARGUMENTS

Follow these steps exactly:

1. Use `search_templates` with queries like "audio", "text to audio", "music" or "speech", or `tag: "Audio"`. If a good template exists, read it with `get_template` and use it as the reference.

2. If no template fits, use `search_nodes` with `output_type: "AUDIO"` and queries like "audio" or "tts" to find the installed audio nodes, and `search_models` for audio model files (checkpoints such as stable audio, text encoders).

3. Build the API-format workflow JSON with the audio nodes the task needs (music generation, sound effects or text-to-speech vary by the installed nodes). Templates come from `get_template` in UI format (nodes with `type`, `widgets_values`, `links`): read them as the reference for which nodes, models and wiring the task needs, then write the API-format prompt (`{"<id>": {"class_type", "inputs"}}`, an input being a value or `["<from id>", <output index>]`). `search_nodes` gives each input name and widget order.

4. **Check the workflow has inputs and outputs before submitting.** The JSON must contain at least one input node carrying the user intent (CLIPTextEncode for prompts, LoadImage for a source image) and at least one output node wired to the final result (SaveImage, PreviewImage, SaveAudio, SaveVideo, SaveAnimatedWEBP, or the matching node of the installed pack). Without an output node the job runs and leaves nothing to fetch. Use the exact class names and input names that `search_nodes` shows; `submit_workflow` reports what the server refused. The audio output node is SaveAudio (or SaveAudioMP3, SaveAudioOpus, SaveAudioAdvanced on newer servers: check `search_nodes` for which exist and their inputs).

5. Call `submit_workflow` with the workflow JSON.

6. Poll `get_job_status` with the prompt_id every few seconds until it is completed, with a brief status line for the user; if the user asks to stop, use `cancel_job`. Then call `get_output` with a short `description` (a few words naming the result) and show the user the saved path; open an image with the Read tool so they see it. Audio files are saved to disk and not played inline.

If any step fails, show the error clearly. Audio support in ComfyUI is newer than images, so fewer templates and models may be installed.

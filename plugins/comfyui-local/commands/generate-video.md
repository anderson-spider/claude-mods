---
description: Generate, edit, or extend a video on your ComfyUI
---

Generate, edit, or extend a video on the user's ComfyUI server based on their description: $ARGUMENTS

Follow these steps exactly:

1. Use `search_templates` with queries like "text to video", "image to video" or "video", or `tag: "Video"`, and with `model` when the user named a family (Wan, LTX, Hunyuan, Mochi, CogVideoX...). If a good template exists, read it with `get_template` and use it as the reference.

2. Use `search_models` to find the video model files on the server (usually under diffusion_models, text_encoders and vae) and `search_nodes` to confirm the loader, sampler and video output nodes the template needs are installed. Only what they list exists.

3. If the user provides an input image (image-to-video), use `upload_file` first and put the returned name in a LoadImage node.

4. Build the API-format workflow JSON with the video nodes the template shows: specialized loaders, video samplers, and a video output node (SaveVideo, SaveAnimatedWEBP, or a video combine node from an installed pack: find it with `search_nodes input_type: "IMAGE"` and the word "video"). Templates come from `get_template` in UI format (nodes with `type`, `widgets_values`, `links`): read them as the reference for which nodes, models and wiring the task needs, then write the API-format prompt (`{"<id>": {"class_type", "inputs"}}`, an input being a value or `["<from id>", <output index>]`). `search_nodes` gives each input name and widget order.

5. **Check the workflow has inputs and outputs before submitting.** The JSON must contain at least one input node carrying the user intent (CLIPTextEncode for prompts, LoadImage for a source image) and at least one output node wired to the final result (SaveImage, PreviewImage, SaveAudio, SaveVideo, SaveAnimatedWEBP, or the matching node of the installed pack). Without an output node the job runs and leaves nothing to fetch. Use the exact class names and input names that `search_nodes` shows; `submit_workflow` reports what the server refused.

6. Before submitting, set expectations from `system_info`: video takes minutes, scales with resolution and frame count, and can run out of VRAM; a shorter or smaller clip is the fix.

7. Call `submit_workflow` with the workflow JSON.

8. Poll `get_job_status` with the prompt_id every few seconds until it is completed, with a brief status line for the user; if the user asks to stop, use `cancel_job`. Then call `get_output` with a short `description` (a few words naming the result) and show the user the saved path; open an image with the Read tool so they see it. Video files are saved to disk and not previewed inline.

If any step fails, show the error clearly. Common video issues: a model file not on the server, out of VRAM for long or large clips, a frame count the model does not accept.

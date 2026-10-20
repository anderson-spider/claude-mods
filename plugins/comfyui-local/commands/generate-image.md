---
description: Generate, edit, or modify an image on your ComfyUI
---

Generate, edit, or modify an image on the user's ComfyUI server based on their description: $ARGUMENTS

Follow these steps exactly:

1. Use `search_templates` to find a workflow template that matches the request (such as "text to image", "image to image", "style transfer", "inpainting"), filtering by `tag` or `model` when the user named one. If a good one exists, read it with `get_template` and use it as the reference instead of designing from scratch.

2. Use `search_models` to see which checkpoints, diffusion models, text encoders, VAEs and LoRAs are on the server, and pick what fits the request (a realistic checkpoint for a photo, an anime one for anime, SDXL or a newer model for quality). Only files it lists exist; never assume a model name. Confirm with `search_nodes` that the loader nodes the chosen model needs are installed.

3. If the user provides an input image (img2img, style transfer, reference), use `upload_file` to upload it and put the returned name in a LoadImage node.

4. Build the API-format workflow JSON. A standard text-to-image workflow uses CheckpointLoaderSimple, CLIPTextEncode (positive and negative), EmptyLatentImage, KSampler, VAEDecode, SaveImage; for img2img replace EmptyLatentImage with LoadImage and VAEEncode. Newer model families use their own loader and sampler nodes: follow the template. Templates come from `get_template` in UI format (nodes with `type`, `widgets_values`, `links`): read them as the reference for which nodes, models and wiring the task needs, then write the API-format prompt (`{"<id>": {"class_type", "inputs"}}`, an input being a value or `["<from id>", <output index>]`). `search_nodes` gives each input name and widget order.

5. **Check the workflow has inputs and outputs before submitting.** The JSON must contain at least one input node carrying the user intent (CLIPTextEncode for prompts, LoadImage for a source image) and at least one output node wired to the final result (SaveImage, PreviewImage, SaveAudio, SaveVideo, SaveAnimatedWEBP, or the matching node of the installed pack). Without an output node the job runs and leaves nothing to fetch. Use the exact class names and input names that `search_nodes` shows; `submit_workflow` reports what the server refused.

6. Call `submit_workflow` with the workflow JSON.

7. Poll `get_job_status` with the prompt_id every few seconds until it is completed, with a brief status line for the user; if the user asks to stop, use `cancel_job`. Then call `get_output` with a short `description` (a few words naming the result) and show the user the saved path; open an image with the Read tool so they see it.

If any step fails, show the error clearly and suggest what might be wrong (missing model file, wrong node input, out of VRAM: reduce the resolution or steps). `system_info` tells the GPU and its free VRAM.

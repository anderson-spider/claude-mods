---
description: Upscale an image on your ComfyUI
---

Upscale an image on the user's ComfyUI server: $ARGUMENTS

Follow these steps exactly:

1. Use `search_templates` with queries like "upscale" or "super resolution", or `tag: "Upscale"`. If a good template exists, read it with `get_template` and use it as the reference.

2. Use `search_models` with `folder: "upscale_models"` to see the upscalers installed and pick from what is listed by its name: the factor (2x, 4x) and the kind of image it was trained for (photo, anime, general) are usually in the file name.

3. The user must provide an input image: `upload_file` it and put the returned name in a LoadImage node.

4. Build the API-format workflow JSON: LoadImage, UpscaleModelLoader, ImageUpscaleWithModel, SaveImage. For more detail, a second pass through img2img with a checkpoint at low denoise (0.2 to 0.4) adds texture. Templates come from `get_template` in UI format (nodes with `type`, `widgets_values`, `links`): read them as the reference for which nodes, models and wiring the task needs, then write the API-format prompt (`{"<id>": {"class_type", "inputs"}}`, an input being a value or `["<from id>", <output index>]`). `search_nodes` gives each input name and widget order.

5. **Check the workflow has inputs and outputs before submitting.** The JSON must contain at least one input node carrying the user intent (CLIPTextEncode for prompts, LoadImage for a source image) and at least one output node wired to the final result (SaveImage, PreviewImage, SaveAudio, SaveVideo, SaveAnimatedWEBP, or the matching node of the installed pack). Without an output node the job runs and leaves nothing to fetch. Use the exact class names and input names that `search_nodes` shows; `submit_workflow` reports what the server refused.

6. Call `submit_workflow` with the workflow JSON.

7. Poll `get_job_status` with the prompt_id every few seconds until it is completed, with a brief status line for the user; if the user asks to stop, use `cancel_job`. Then call `get_output` with a short `description` (a few words naming the result) and show the user the saved path; open an image with the Read tool so they see it. Mention the output resolution against the input when known.

If any step fails, show the error clearly. A large input can run out of VRAM: suggest downscaling first or a tiled upscaler node (such as UltimateSDUpscale) if `search_nodes` finds one.

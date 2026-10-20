---
description: Remove the background from an image on your ComfyUI
---

Remove the background from an image on the user's ComfyUI server: $ARGUMENTS

Follow these steps exactly:

1. Use `search_templates` with queries like "remove background" or "background". If a good template exists, read it with `get_template` and use it as the reference.

2. Use `search_nodes` to find the installed background removal nodes: search "background", "RMBG", "BiRefNet", "matting", "segment", or `search_models` with `folder: "background_removal"` for their model files. Only what is listed exists.

3. The user must provide an input image: `upload_file` it and put the returned name in a LoadImage node.

4. Build the API-format workflow JSON: LoadImage, the background removal node, SaveImage (PNG keeps the transparency). To replace the background rather than remove it, add a second image and composite them. Templates come from `get_template` in UI format (nodes with `type`, `widgets_values`, `links`): read them as the reference for which nodes, models and wiring the task needs, then write the API-format prompt (`{"<id>": {"class_type", "inputs"}}`, an input being a value or `["<from id>", <output index>]`). `search_nodes` gives each input name and widget order.

5. **Check the workflow has inputs and outputs before submitting.** The JSON must contain at least one input node carrying the user intent (CLIPTextEncode for prompts, LoadImage for a source image) and at least one output node wired to the final result (SaveImage, PreviewImage, SaveAudio, SaveVideo, SaveAnimatedWEBP, or the matching node of the installed pack). Without an output node the job runs and leaves nothing to fetch. Use the exact class names and input names that `search_nodes` shows; `submit_workflow` reports what the server refused.

6. Call `submit_workflow` with the workflow JSON.

7. Poll `get_job_status` with the prompt_id every few seconds until it is completed, with a brief status line for the user; if the user asks to stop, use `cancel_job`. Then call `get_output` with a short `description` (a few words naming the result) and show the user the saved path; open an image with the Read tool so they see it. The output is a PNG with transparency when the background was removed rather than replaced.

If any step fails, show the error clearly. If no background removal node is installed, say so and offer to find a pack with `manager_search_packs` (ComfyUI-Manager) or an inpainting approach.

---
description: Generate a 3D model on your ComfyUI
---

Generate a 3D model on the user's ComfyUI server based on their description: $ARGUMENTS

Prefer a ready-made template over hand-building, and discover the current options with the tools rather than assuming a fixed catalog.

1. **Look for a template first.** Call `search_templates` with `tag: "3D"` or a query like "image to 3d". If one fits, read it with `get_template` and use it as the reference: swap in the user's input and adjust settings.

2. **If no template fits, discover nodes structurally.** Use `search_nodes` with `output_type: "FILE_3D_GLB"` (also MESH, FILE_3D_OBJ) to find nodes that produce a 3D file, `category: "3d"` to browse, and `input_type: "IMAGE"` for image-to-3D. Use `search_models` for the model files they need. Do not paste in remembered node or model names: query for them.

3. If the user provides a reference image, `upload_file` it first and put the returned name in a LoadImage node.

4. Build the API-format workflow JSON: an input, the 3D generation or reconstruction node, and a 3D save node. Templates come from `get_template` in UI format (nodes with `type`, `widgets_values`, `links`): read them as the reference for which nodes, models and wiring the task needs, then write the API-format prompt (`{"<id>": {"class_type", "inputs"}}`, an input being a value or `["<from id>", <output index>]`). `search_nodes` gives each input name and widget order.

5. **Check the workflow has inputs and outputs before submitting.** The JSON must contain at least one input node carrying the user intent (CLIPTextEncode for prompts, LoadImage for a source image) and at least one output node wired to the final result (SaveImage, PreviewImage, SaveAudio, SaveVideo, SaveAnimatedWEBP, or the matching node of the installed pack). Without an output node the job runs and leaves nothing to fetch. Use the exact class names and input names that `search_nodes` shows; `submit_workflow` reports what the server refused. Find the save node with `search_nodes output_type: "FILE_3D_GLB"` if unsure.

6. Call `submit_workflow`. 3D generation can take longer than images.

7. Poll `get_job_status` with the prompt_id every few seconds until it is completed, with a brief status line for the user; if the user asks to stop, use `cancel_job`. Then call `get_output` with a short `description` (a few words naming the result) and show the user the saved path; open an image with the Read tool so they see it. 3D outputs may include mesh files (.obj, .glb), textures or preview images.

If a step fails, show the error clearly and use the search tools to find a current alternative rather than assuming none exists.

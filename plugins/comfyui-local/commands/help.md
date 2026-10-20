---
description: Show what you can do with the self-hosted ComfyUI
---

Show the user what they can do with the comfyui-local tools, which talk to their own ComfyUI server (the `url` plugin option).

Call `system_info` first and open with what it says: ComfyUI version, GPU and VRAM, queue, and whether ComfyUI-Manager is installed.

Then explain, briefly and in a friendly tone:

**What you can do:**

- Generate images, video, audio or 3D from a description, with the models installed on the server
- Upload input images for img2img, style transfer, upscaling or any workflow that needs a source image
- List the model files on the server (`search_models`), the nodes installed, core and custom (`search_nodes`), and the workflow templates it ships (`search_templates`, `get_template`)
- Build and run multi-step workflows (img2img, upscaling, background removal, style transfer)
- Watch, cancel and fetch jobs (`get_job_status`, `cancel_job`, `get_output`)
- With ComfyUI-Manager 4: list the installed node packs, search the Comfy Registry and install, update, disable or remove a pack (`manager_packs`, `manager_search_packs`, `manager_task`); ComfyUI must be restarted afterwards

**Quick examples to try:**

- "Generate a photo of a mountain lake at golden hour"
- "Which checkpoints do I have?"
- "What upscaling nodes are installed?"
- "Upload this photo and turn it into a watercolor painting"
- "Install the pack that adds RMBG background removal"

**How it works:** everything runs on the user's server and GPU, nothing goes to a cloud. The commands are `/comfyui-local:generate-image`, `generate-video`, `generate-audio`, `generate-3d`, `upscale-image`, `remove-background`, `search-models`, `search-nodes`, `search-templates` and this one.

**Tips:** describe the prompt in detail and name a style; the model set is whatever `search_models` lists, so never assume a model exists; outputs are saved under `comfyui-outputs/` in the working directory unless another folder is given.

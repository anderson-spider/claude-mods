---
description: Find the workflow templates your ComfyUI ships
---

Search the workflow templates on the user's ComfyUI server: $ARGUMENTS

Use `search_templates` to find templates matching the request. Templates come with ComfyUI (core) and with installed node packs.

Search strategies:

- If the user describes a task ("generate a video from an image"), search by `query`
- If they mention a category ("text to image", "video", "upscale", "audio", "3D"), filter by `tag`
- If they mention a model family (Flux, Wan, LTX, SDXL), filter by `model`

Present the results in a clean format: title and name, pack when it is not core, first sentence of the description, tags, models, and a note when the template needs a partner API node (those need an API key configured on the server). If there are many results, show the top 10 and mention the total count.

To run one, read it with `get_template` and build the API-format prompt from it (the template is in UI format); `search_models` tells whether the models it needs are on the server.

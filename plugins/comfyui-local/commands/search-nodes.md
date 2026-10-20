---
description: Search the nodes installed on your ComfyUI, with wiring hints
---

Search the nodes installed on the user's ComfyUI server: $ARGUMENTS

Use `search_nodes` with the user's words as `query`. If they asked about a category (image processing, sampling, conditioning, loaders), filter by `category`. If they asked about I/O types (IMAGE, LATENT, MODEL, AUDIO), filter by `input_type` or `output_type`. If they asked about a pack, filter by `pack` ("core" for built-in nodes).

Present the results clearly:

- Node class name and display name
- Category and pack (core, or the custom node pack it belongs to)
- Inputs (name: type, with ? for optional and = for the default) and outputs

If they are looking for nodes to accomplish a task, suggest which nodes to use together and how to wire them in an API-format prompt. If no installed node fits and ComfyUI-Manager is installed, offer `manager_search_packs` to find a pack that adds it.

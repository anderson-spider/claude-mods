# comfyui-local

Generate images, video, audio and 3D on your own ComfyUI server, search the nodes, models and templates it has, run and fetch jobs, and manage custom node packs through ComfyUI-Manager. Everything runs on your server and GPU; nothing goes to Comfy Cloud.

```text
/plugin install comfyui-local --marketplace anderson-spider/claude-mods
```

This plugin is not affiliated with or endorsed by Comfy Org. The official `comfy-cloud` plugin ([Comfy-Org/comfy-skills](https://github.com/Comfy-Org/comfy-skills), MIT) connects Claude Code to the hosted Comfy Cloud MCP server; this one talks to a self-hosted ComfyUI over its HTTP API instead, and its slash commands are adapted from the official ones (`commands/LICENSE.comfy-skills.txt`).

Set one plugin option from the plugin's configuration in `/plugin` (or `claude plugin configure comfyui-local`), in your user options, not in a repository's settings:

- `url`: your server's origin, such as `http://192.168.0.10:8188`. Plain `http` is accepted, since the server is on your local network; ComfyUI has no authentication of its own, and this plugin sends none.

Without it the tools answer with an error that says where to set it. Requires ComfyUI 0.3 or later for the core tools and ComfyUI-Manager 4 or later for the `manager_*` ones (older Managers answer 404 and the tools say so).

## Use

Slash commands, each a thin recipe over the tools: `/comfyui-local:generate-image`, `generate-video`, `generate-audio`, `generate-3d`, `upscale-image`, `remove-background`, `search-models`, `search-nodes`, `search-templates` and `help`. They never hard-code a model or node: they find what your server has at run time.

Tools (`mcp__comfyui-local__<name>`):

- `system_info`: ComfyUI version, GPU and VRAM, queue counts, Manager version.
- `search_nodes`: the installed nodes, core and custom, by words, `category`, `pack`, `input_type` or `output_type`, with each input's name, type and default and each output.
- `search_models`: the model files as `folder/file`, by words or one `folder` (checkpoints, diffusion_models, loras, vae, text_encoders, upscale_models, ...).
- `search_templates` and `get_template`: the workflow templates ComfyUI and its node packs ship, by words, `tag` or `model`; `get_template` returns one in the UI format (nodes, widgets, links) as the reference to build an API-format prompt.
- `submit_workflow`: queues an API-format prompt (node id to `class_type` and `inputs`) and answers the `prompt_id`, or the server's validation errors per node.
- `get_job_status`: pending (with its place), running, completed (with its output files) or failed (with the node error); without a `prompt_id`, the queue.
- `cancel_job`: removes a pending job, interrupts a running one, or clears the queue.
- `upload_file`: sends a local image, video or audio file to the server's input folder and answers the name a LoadImage node takes.
- `get_output`: downloads a finished job's files into `comfyui-outputs/` (or `directory`) named after `description`, and answers the paths.
- `manager_packs`, `manager_search_packs`, `manager_task`: the packs installed through ComfyUI-Manager with version and state, a search of the public [Comfy Registry](https://registry.comfy.org) for packs to install, and one queued task (install, update, uninstall, disable, enable, fix). ComfyUI must be restarted afterwards for the nodes to change; the plugin does not restart it.

Uploads and downloads go through `curl` on your machine, since the plugin API carries text only. Long answers are cut at 60,000 characters; use the filters and `limit`.

No tool asks for confirmation: the server is yours and local. To let Claude call them without prompts, allow `mcp__comfyui-local__*` in your permission rules, or only the read ones (`system_info`, `search_*`, `get_*`, `manager_packs`, `manager_search_packs`) if you prefer to approve each job, upload and Manager task.

## Privacy

The server comes only from the `url` option, not from tool input or the environment. On every call the plugin reads the user, project and local settings; if the project or local settings declare `url` for this plugin with a value your user settings do not give it, or the settings cannot be read, the call is refused and nothing is sent, because a repository could otherwise point your uploads at a server it chose. A value equal to your own is accepted. The only request that leaves your network is `manager_search_packs`, which queries `api.comfy.org` with the search words.

## Tests

Pure API, option and host tests use fake fetches, processes and settings: each tool's answer and refusals, URL checks, the repository-chosen option, curl argument shapes and registration. They do not exercise a real ComfyUI server. For editing pointers and check commands, see [AGENTS.md](AGENTS.md).

# comfyui-local

Generate images, video, audio and 3D on your own ComfyUI server, search the nodes, models and templates it has, run and fetch jobs, keep workflows in your library, and manage custom node packs through ComfyUI-Manager, restarting the server to load them. Everything runs on your server and GPU; nothing goes to Comfy Cloud.

```text
/plugin install comfyui-local --marketplace anderson-spider/claude-mods
```

This plugin is not affiliated with or endorsed by Comfy Org. The official `comfy-cloud` plugin ([Comfy-Org/comfy-skills](https://github.com/Comfy-Org/comfy-skills), MIT) connects Claude Code to the hosted Comfy Cloud MCP server; this one talks to a self-hosted ComfyUI over its HTTP API instead, and its slash commands are adapted from the official ones (`commands/LICENSE.comfy-skills.txt`).

Set one plugin option from the plugin's configuration in `/plugin` (or `claude plugin configure comfyui-local`), in your user options, not in a repository's settings:

- `url`: your server's origin, such as `http://192.168.0.10:8188`. Plain `http` is accepted, since the server is on your local network; ComfyUI has no authentication of its own, and this plugin sends none.

Without it the tools answer with an error that says where to set it. Requires ComfyUI 0.3 or later for the core tools and ComfyUI-Manager 4 or later for `manager_packs`, `manager_task` and `restart_server` (a 404 from the Manager, missing or older, is reported as such). `manager_search_packs` queries the public registry and needs no Manager.

## Use

Slash commands, each a thin recipe over the tools: `/comfyui-local:generate-image`, `generate-video`, `generate-audio`, `generate-3d`, `upscale-image`, `remove-background`, `search-models`, `search-nodes`, `search-templates` and `help`. They do not hard-code a model: they find what your server has at run time. Core node class names appear only as the usual starting point, and each node's inputs come from `search_nodes`.

Tools (`mcp__comfyui-local__<name>`):

- `system_info`: ComfyUI version, GPU and VRAM, queue counts, Manager version.
- `search_nodes`: the installed nodes, core and custom, by words, `category`, `pack`, `input_type` or `output_type`, with each input's name, type and default and each output.
- `search_models`: the model files as `folder/file`, by words or one `folder` (checkpoints, diffusion_models, loras, vae, text_encoders, upscale_models, ...).
- `search_templates` and `get_template`: the workflow templates ComfyUI and its node packs ship, by words, `tag` or `model`; `get_template` returns one in the UI format (nodes, widgets, links) as the reference to build an API-format prompt.
- `submit_workflow`: queues an API-format prompt (node id to `class_type` and `inputs`) and answers the `prompt_id`, or the server's validation errors per node.
- `get_job_status`: pending (with its place), running, completed (with its output files) or failed (with the node error); without a `prompt_id`, the queue.
- `cancel_job`: removes a pending job, interrupts a running one, or clears the queue.
- `upload_file`: sends a local image, video or audio file to the server's input folder (or a `subfolder` of it) and answers the name a LoadImage node takes; `overwrite` replaces a file of the same name instead of renaming the upload.
- `get_output`: downloads a finished job's files into `comfyui-outputs/` (or `directory`) named after `description`, and answers the paths.
- `manager_packs`, `manager_search_packs`, `manager_task`: the packs installed through ComfyUI-Manager with version, state and the recent task results, a search of the public [Comfy Registry](https://registry.comfy.org) for packs to install, and one queued task (install by registry id; update, uninstall, disable, enable or fix an installed pack by its folder or registry id). The result is reported when the task is quick, else `manager_packs` shows it; a quick task that fails, such as one the Manager's security level forbids, is reported as an error. ComfyUI must be restarted afterwards for the nodes to change (`restart_server`).
- `restart_server`: restarts ComfyUI through the Manager (`POST /v2/manager/reboot`), then polls `/system_stats` (every 2 seconds, the first after half a second when the connection dropped, for up to 2 minutes) and answers how long it took, the ComfyUI version and the node packs that failed to import. It counts as restarted only once a poll has found the server down, so an answer from a process that never restarted is reported as such. It refuses while a job runs or waits, since a restart kills the running job and drops the pending ones, unless `force`. The Manager allows it only at `security_level` middle or above (`user/__manager/config.ini`); a 403 says so. The server comes back by itself when ComfyUI runs in the foreground or under a service manager such as systemd, since the Manager re-executes the process in place; under comfy-cli the Manager exits and leaves comfy-cli a marker to start it again.
- `save_workflow`, `list_workflows`, `get_workflow`: the workflow library of the default user (`user/default/workflows/` on the server, the frontend's and the desktop app's Workflows tab) through `/api/userdata`. `save_workflow` takes a `path` relative to it (a leading `workflows/` is taken as that folder), subfolders allowed and `.json` added when missing, and a UI-format workflow (`nodes` and `links` arrays); it refuses `..`, absolute paths, `%`, colons and control characters in the path, and an API-format prompt, which inside `workflows/` breaks the frontend's list, and replaces an existing file only with `overwrite`. `list_workflows` answers each path with its size and date, and `get_workflow` one workflow's JSON as the base for an edit. A workflow too large for one answer, or any with `file`, is written indented to a local file instead (by default `comfyui-outputs/workflows/<path>.json`); edit it there and save it back with `save_workflow` and `file` in place of `workflow`. Converting an API-format prompt to the UI format needs the frontend's graph layout and is not done here.

Uploads and downloads go through `curl` on your machine, since the plugin API carries text only: `upload_file` and `get_output` need `curl` on the PATH (macOS and most Linux distributions ship it; Windows 10 and later too). The other tools do not. Long answers are cut at 60,000 characters; use the filters and `limit`.

No tool asks for confirmation: the server is yours and local. To let Claude call them without prompts, allow `mcp__comfyui-local__*` in your permission rules; to approve each job, upload, download and Manager task yourself, allow only the ones that read: `system_info`, `search_nodes`, `search_models`, `search_templates`, `get_template`, `get_job_status`, `manager_packs`, `manager_search_packs`, `list_workflows` and `get_workflow`.

Node packs and Python dependencies: `manager_task` install lets the Manager install a pack's `requirements.txt`. It skips `torch`, `torchaudio`, `torchsde` and `torchvision` named there, but not what the other requirements pull in: a package that depends on torch can still replace the server's own build (a ROCm or CUDA torch, say), and `onnxruntime-gpu` installs over `onnxruntime`, which can break the server. Read a pack's requirements before installing it; for one that brings torch, torchvision or onnxruntime-gpu in, install the pack and its requirements on the server yourself, with pip constraints that pin the builds you have.

## Privacy

The server comes only from the `url` option, not from tool input or the environment. On every call the plugin reads the user, project and local settings; if the project or local settings declare `url` for this plugin with a value your user settings do not give it, or the settings cannot be read, the call is refused and nothing is sent, because a repository could otherwise point your uploads at a server it chose. A value equal to your own is accepted. The only request that leaves your network is `manager_search_packs`, which queries `api.comfy.org` with the search words.

## Tests

Pure API, option and host tests use fake fetches, processes and settings: each tool's answer and refusals, URL checks, the repository-chosen option, curl argument shapes and registration. They do not exercise a real ComfyUI server. For editing pointers and check commands, see [AGENTS.md](AGENTS.md).

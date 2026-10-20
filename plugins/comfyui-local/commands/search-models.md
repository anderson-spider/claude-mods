---
description: List the model files on your ComfyUI
---

List the model files on the user's ComfyUI server: $ARGUMENTS

Use `search_models` with the user's words as `query`; if they named a type (checkpoint, lora, vae, controlnet, upscaler, text encoder, diffusion model), pass the matching `folder` (checkpoints, loras, vae, controlnet, upscale_models, text_encoders, diffusion_models). Without arguments, list every folder.

Present the results grouped by folder, one file per line, and say which loader node takes each folder (CheckpointLoaderSimple for checkpoints, LoraLoader for loras, UNETLoader for diffusion_models, CLIPLoader for text_encoders, VAELoader for vae, UpscaleModelLoader for upscale_models).

If there are many results, show the top 20 and mention the total count. Models are installed outside this plugin: to add one, the user copies the file into the matching models folder on the server.

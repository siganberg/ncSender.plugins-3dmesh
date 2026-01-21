# 3DMesh Plugin

> **IMPORTANT DISCLAIMER:** This plugin is part of my personal ncSender project. If you choose to use it, you do so entirely at your own risk. I am not responsible for any damage, malfunction, or personal injury that may result from the use or misuse of this plugin. Use it with caution and at your own discretion.

Surface mesh probing with Z compensation for milling curved or warped materials using flat 2D programming. This plugin probes a grid of points across your workpiece to create a height map, then applies Z compensation to your G-code program.

## Features

- **Surface Probing** - Automatically probe a grid of points to map surface variations
- **Grid Configuration** - Manual or automatic grid setup based on loaded G-code bounds
- **Mesh Management** - Save and load mesh data for reuse across sessions
- **Z Compensation** - Apply bilinear interpolation for smooth Z adjustments
- **G-code Generation** - Creates a new compensated G-code file from your original program

## Use Cases

- Milling on uneven or warped stock material
- Engraving on curved surfaces (guitar bodies, furniture, etc.)
- PCB milling on slightly warped boards
- Any application where the workpiece surface isn't perfectly flat

## Configuration

Access settings via **Plugins → 3DMesh** in the toolbar menu.

### Grid Settings

| Setting | Description |
|---------|-------------|
| **Grid Mode** | Manual (specify bounds) or Auto (from G-code) |
| **Grid Size** | Number of probe points in X and Y directions |
| **Start X/Y** | Lower-left corner of probe area (manual mode) |
| **End X/Y** | Upper-right corner of probe area (manual mode) |

### Probe Settings

| Setting | Description | Default |
|---------|-------------|---------|
| **Probe Feed Rate** | Speed for probing moves | 100 mm/min |
| **Retract Height** | Height to retract between probes | 5 mm |
| **Max Plunge** | Maximum probe depth below start | 20 mm |

### Compensation Settings

| Setting | Description |
|---------|-------------|
| **Reference Z** | The Z height that represents "zero" in your mesh |

## How It Works

### 1. Setup Grid
Configure the probe grid either manually (specify X/Y bounds) or automatically from the loaded G-code program bounds.

### 2. Run Probing
The plugin generates a sequence of G38.2 probe commands to measure Z height at each grid point. The probed heights are stored in memory.

### 3. Save/Load Mesh (Optional)
Save the mesh data to a file for reuse, or load a previously saved mesh.

### 4. Apply Compensation
The plugin reads your original G-code, calculates Z offset for each move using bilinear interpolation from the mesh, and generates a new compensated G-code file.

## Probing Sequence

For each grid point, the plugin:
1. Rapid move to XY position at safe height
2. Probe down using G38.2 until contact
3. Record Z position
4. Retract to safe height
5. Move to next point

## Bilinear Interpolation

For any point within the probed grid, the Z offset is calculated using bilinear interpolation from the four surrounding probe points. This provides smooth transitions rather than discrete steps.

## Requirements

- ncSender v0.3.131 or later
- 3D touch probe or similar probing device
- Probe input configured in GRBL/grblHAL

## Installation

Install this plugin in ncSender through the **Plugins** interface.

## Development

This plugin is part of the ncSender ecosystem: https://github.com/siganberg/ncSender

## License

See main ncSender repository for license information.

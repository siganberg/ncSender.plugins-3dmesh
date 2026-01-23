# 3DMesh Plugin

> **IMPORTANT DISCLAIMER:** This plugin is part of my personal ncSender project. If you choose to use it, you do so entirely at your own risk. I am not responsible for any damage, malfunction, or personal injury that may result from the use or misuse of this plugin. Use it with caution and at your own discretion.

Surface mesh probing with Z compensation for milling curved or warped materials using flat 2D programming. This plugin probes a grid of points across your workpiece to create a height map, then applies Z compensation to your G-code program.

## Features

- **Safe Probing Strategy** - No rapid G0 moves; all movements use probe commands to prevent crashes
- **Curved Surface Optimization** - Smart lateral probing with bounce detection for efficient probing on curved surfaces
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
| **Probe Feed Rate** | Speed for vertical plunge probing | 100 mm/min |
| **Travel Feed Rate** | Speed for lateral probe moves (safe travel) | 2000 mm/min |
| **Clearance Height** | Height to retract above last probed point | 5 mm |
| **Max Plunge** | Maximum probe depth below current position | 20 mm |

### Compensation Settings

| Setting | Description |
|---------|-------------|
| **Reference Z** | The Z height that represents "zero" in your mesh |

## Safe Probing Strategy

This plugin uses an advanced probing strategy designed for **safety** and **efficiency** on curved surfaces.

### Why No Rapid (G0) Moves?

Traditional probing uses G0 rapid moves between points. This is dangerous because:
- If the user makes a positioning mistake, the probe can crash into the workpiece at full speed
- On curved surfaces, the "safe" height might not actually be safe

This plugin **never uses G0 moves**. Instead, all movements use probe commands:
- **G38.3** - Probe toward workpiece (no error if no contact) - used for travel
- **G38.4** - Probe away from workpiece - used for retracting
- **G38.2** - Probe toward workpiece (error if no contact) - used for actual measurement

### Bounce-on-Hit Strategy for Curved Surfaces

When moving laterally between probe points, the plugin uses G38.3 which will stop if the probe triggers. This enables smart navigation over curved surfaces:

**For climbing surfaces (surface rises from left to right):**
1. Finish probing point A
2. Retract 5mm (clearance height) above point A
3. Start lateral move toward point B using G38.3
4. If probe triggers before reaching B (hit the rising surface):
   - Bounce up 5mm from hit point
   - Continue lateral move toward B
   - Repeat bouncing as needed until B is reached
5. Plunge probe at B to get accurate measurement

**For descending surfaces (surface drops from left to right):**
1. Finish probing point A
2. Retract 5mm above point A
3. Lateral move toward B - probe doesn't trigger (surface is below)
4. Plunge probe at B finds the lower surface

### Row Transition Safety

When finishing a row and moving to the next row, the plugin:
1. Tracks the **highest Z** probed in the current row
2. Retracts to highest Z + clearance height (not just the last point)
3. Safely moves X back to start position (with bounce detection)
4. Moves Y to next row (with bounce detection)

This prevents crashes when the surface has a peak in the middle of a row.

## Probing Sequence

The grid is probed **left-to-right, front-to-back** (increasing X within each row, then increasing Y for each new row).

For each grid point:
1. **Safe lateral move** to XY position using G38.3 (with bounce-on-hit)
2. **Plunge probe** using G38.2 to measure actual surface height
3. **Record Z position** and update row's highest Z
4. Move to next point

## Bilinear Interpolation

For any point within the probed grid, the Z offset is calculated using bilinear interpolation from the four surrounding probe points. This provides smooth transitions rather than discrete steps.

## How It Works

### 1. Setup Grid
Configure the probe grid either manually (specify X/Y bounds) or automatically from the loaded G-code program bounds.

### 2. Run Probing
Position the probe at or above the starting corner. The plugin will safely navigate to each grid point using the bounce-on-hit strategy and measure the surface height.

### 3. Save/Load Mesh (Optional)
Save the mesh data to a file for reuse, or load a previously saved mesh.

### 4. Apply Compensation
The plugin reads your original G-code, calculates Z offset for each move using bilinear interpolation from the mesh, and generates a new compensated G-code file.

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

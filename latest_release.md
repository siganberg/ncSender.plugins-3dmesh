

## What's Changed

### ✨ New Features
- Initial implementation of 3DMesh surface probing and Z compensation plugin
- Smart probing strategy with bounce-on-hit detection for reliable surface mapping
- Subdivide long G-code moves for smooth Z compensation curves
- 3D mesh visualizer for previewing probe results
- Built-in mesh library for saving and loading probe data
- CI/CD workflow and automated release packaging

### 🐛 Bug Fixes
- Fix probe pin state detection using actual hardware signal instead of position tracking
- Fix pre-plunge retract to prevent ALARM:4 when lateral moves end at the surface
- Fix infinite loop on command failure with proper error handling
- Fix bounce height to ensure probe reliably de-triggers between points
- Fix Z compensation for XY-only moves so all segments are properly adjusted
- Fix API connection for remote client access

### 🔧 Improvements
- Convert plugin to V2 format for improved compatibility
- Merge configuration tabs and simplify grid setup for easier workflow
- Sticky Apply button in header for quick access
- Program-loaded gate prevents running compensation without valid G-code
- Replace intrusive alert dialogs with subtle toast notifications
- Simplified and more reliable probing workflow

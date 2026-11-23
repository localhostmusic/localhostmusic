// Visualizer style registry. Renderers live in their own components: "bars",
// "wave" and "radial" are GlowVisualizer, "trip" is ShaderVisualizer, and the rest
// are <Name>Visualizer.
export type VizStyle = "bars" | "wave" | "radial" | "trip" | "orb" | "neon" | "iris" | "fracture" | "siphon" | "silk";
export const VIZ_STYLES: VizStyle[] = ["bars", "wave", "radial", "trip", "orb", "neon", "iris", "fracture", "siphon", "silk"];

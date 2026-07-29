# menucap.mjs — ysflight-web VR menu phase probe (2026-07-29)

Exploration artifact. Proves the full VR menu phase comes up under emulation
on an AMD iGPU server (no headset, no X):

    node scripts/menucap.mjs

Result: mvLayer=true, menuQuad=true, session sustained at 25-27fps
(watchdog fed by DrawMenu). Requires: --use-angle=vulkan (RADV,
OVR_multiview2), IWER forceInstall, layers polyfill re-applied AFTER
installRuntime, 'layers' added to device supportedFeatures.

Known limit: quad-layer composition doesn't reach the visible canvas
(lum=0 screenshots). For the ◎-offset investigation use the engine's own
test hooks instead (Module.ysfwVr.intersectRayWithAnchoredQuad /
cursorOverlayPoint / beamPoseFor / menu FBO readback) — mechanical
comparison beats screenshots here.

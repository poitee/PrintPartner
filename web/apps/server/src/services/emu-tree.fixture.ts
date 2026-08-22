/**
 * EMU-like repo tree fixture (subset of the real DW-Tas/emu layout, captured
 * from the GitHub tree API). Used by unit tests so they never hit the live
 * GitHub API (unauthenticated rate limit is 60/hr) — only the Docker E2E
 * smoke touches the network.
 */

export const EMU_TREE_FIXTURE: string[] = [
  "README.md",
  "LICENSE",
  "CAD/EMU.step",
  "Manuals/EMU_LED_Button_PCB.pdf",
  "PCB (recommended options)/hatch_board/ReadMe.md",
  "PCB (recommended options)/hatch_board/Gerber/hatch_board_gerber.zip",
  "PCB (recommended options)/multi_led_button/ReadMe.md",
  "PCB (recommended options)/multi_led_button/STL/button_diffuser.stl",
  "PCB (recommended options)/multi_led_button/STL/button_housing.stl",
  "PCB (recommended options)/multi_led_button/STL/Non-MMU diffuser/diffuser.stl",
  "STL/Base/base_frame.stl",
  "STL/Base/base_plate.stl",
  "STL/Base/Optional/base_optional_foot.stl",
  "STL/Box/box_lid.stl",
  "STL/Combiner/combiner_body.stl",
  "STL/Combiner/combiner_cap.stl",
  "STL/Combiner/Deprecated Options/Combiners_with_sensor/old_combiner.stl",
  "STL/Combiner/Deprecated Options/Encoder_no_sensor/old_encoder.stl",
  "STL/Combiner/Deprecated Options/Encoder_with_sensor/old_encoder_sensor.stl",
  "STL/Filamentalist/spool_holder.stl",
  "STL/Filamentalist/(Option) TPU_CDR/tpu_cdr.stl",
  "STL/Stepper/stepper_mount.stl",
  "STL/Stepper/Options/alt_stepper_gear.stl",
  "STL/Tension-compression-sensor/sensor_arm.stl",
  "STL/Tension-compression-sensor/Proportional Sync Feedback (PSF) Version/psf_arm.stl",
  "STL/Tools/alignment_jig.stl",
  "User_Mods/README.md",
  "User_Mods/EMU_Lite/Readme.md",
  "User_Mods/EMU_Lite/STL/lite_base.stl",
  "User_Mods/EMU_Split_base/README.md",
  "User_Mods/EMU_Split_base/STL/split_left.stl",
  "User_Mods/EMU_Split_base/STL/split_right.stl",
  "User_Mods/TPU_feet/STLs/tpu_foot.stl",
  "docs/README.md",
  "macros/emu_macros.cfg",
];

export const EMU_STL_FIXTURE: string[] = EMU_TREE_FIXTURE.filter((p) =>
  p.toLowerCase().endsWith(".stl"),
);

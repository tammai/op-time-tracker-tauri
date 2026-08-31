// Windows release builds get no console window: `windows_subsystem = "windows"`
// suppresses the one a plain binary would allocate. Debug builds keep it, which
// is where `eprintln!` diagnostics from the client are read.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    op_time_tracker_lib::run()
}

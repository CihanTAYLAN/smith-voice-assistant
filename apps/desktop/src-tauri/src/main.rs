// Windows'ta release build'de konsol penceresini gizle.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    smith_desktop_lib::run();
}

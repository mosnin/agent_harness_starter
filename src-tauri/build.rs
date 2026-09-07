// Native assets are embedded by generate_context!; rebuilding JS must rebuild the binary.
fn main() {
    #[cfg(feature = "gui")]
    {
        println!("cargo:rerun-if-changed=../dist/desktop");
        tauri_build::build();
    }
}

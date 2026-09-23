use std::env;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::ExitCode;

use capnp::schema_capnp::code_generator_request;
use capnp::serialize;

const HELP: &str = "Usage: capnpc-rust [--output-directory PATH]\n\
Generate Rust source from an unpacked CodeGeneratorRequest on stdin.\n\n\
Options:\n\
  --output-directory PATH  Write generated files under PATH (default: .)\n\
  --help                   Show this help\n\
  --version                Show the wrapper version\n\n\
Generation uses the pinned capnpc crate directly; no compiler or rustfmt is run.";

/// Rejects requested file names that would place output outside the output
/// directory, before any file is written. Hosts confine writes anyway, but
/// their errors differ (EPERM, ENOTCAPABLE) and native runs are unconfined.
fn check_requested_filenames(request: &[u8]) -> Result<(), String> {
    let mut cursor = request;
    let message = serialize::read_message(&mut cursor, capnp::message::ReaderOptions::new())
        .map_err(|error| error.to_string())?;
    if !cursor.is_empty() {
        return Err(format!(
            "trailing input after the CodeGeneratorRequest ({} bytes)",
            cursor.len()
        ));
    }
    let root = message
        .get_root::<code_generator_request::Reader>()
        .map_err(|error| error.to_string())?;
    for file in root
        .get_requested_files()
        .map_err(|error| error.to_string())?
    {
        let name = file
            .get_filename()
            .and_then(|name| name.to_str().map_err(Into::into))
            .map_err(|error| error.to_string())?;
        let escapes = Path::new(name)
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir));
        if name.is_empty() || escapes {
            return Err(format!(
                "requested file name {name:?} is not a relative path inside the output directory"
            ));
        }
    }
    Ok(())
}

fn run() -> Result<(), String> {
    let mut output_directory = PathBuf::from(".");
    let mut args = env::args_os().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--help" {
            println!("{HELP}");
            return Ok(());
        } else if arg == "--version" {
            println!("capnpc-rust (capnpc-wasm {})", env!("CARGO_PKG_VERSION"));
            return Ok(());
        } else if arg == "--output-directory" {
            output_directory = args
                .next()
                .filter(|path| !path.is_empty())
                .map(PathBuf::from)
                .ok_or("--output-directory requires a path")?;
        } else {
            return Err(format!("unrecognized argument: {}", arg.to_string_lossy()));
        }
    }

    let mut request = Vec::new();
    std::io::stdin()
        .lock()
        .read_to_end(&mut request)
        .map_err(|error| error.to_string())?;
    check_requested_filenames(&request)?;

    // Calling the code generation API preserves the standard plugin boundary
    // without CompilerCommand, subprocesses, or an external formatting tool.
    capnpc::codegen::CodeGenerationCommand::new()
        .output_directory(output_directory)
        .run(&request[..])
        .map_err(|error| error.to_string())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("capnpc-rust: {error}");
            ExitCode::FAILURE
        }
    }
}

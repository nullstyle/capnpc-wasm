use std::env;
use std::path::PathBuf;
use std::process::ExitCode;

const HELP: &str = "Usage: capnpc-rust [--output-directory PATH]\n\
Generate Rust source from an unpacked CodeGeneratorRequest on stdin.\n\n\
Options:\n\
  --output-directory PATH  Write generated files under PATH (default: .)\n\
  --help                   Show this help\n\
  --version                Show the wrapper version\n\n\
Generation uses the pinned capnpc crate directly; no compiler or rustfmt is run.";

fn run() -> Result<(), String> {
    let mut output_directory = PathBuf::from(".");
    let mut args = env::args_os().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--help" {
            println!("{HELP}");
            return Ok(());
        } else if arg == "--version" {
            println!("capnpc-rust (capnp-wasm {})", env!("CARGO_PKG_VERSION"));
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

    // Calling the code generation API preserves the standard plugin boundary
    // without CompilerCommand, subprocesses, or an external formatting tool.
    capnpc::codegen::CodeGenerationCommand::new()
        .output_directory(output_directory)
        .run(std::io::stdin().lock())
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

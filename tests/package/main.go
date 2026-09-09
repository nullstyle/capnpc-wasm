package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	capnpcwasm "github.com/nullstyle/capnpc-wasm/sdk/go"
	"os"
	"path/filepath"
	"time"
)

func main() {
	root := os.Args[1]
	read := func(path string) []byte {
		bytes, err := os.ReadFile(filepath.Join(root, path))
		if err != nil {
			panic(err)
		}
		return bytes
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	compiler, err := capnpcwasm.New(ctx, capnpcwasm.Modules{
		Compiler: read("wasm/capnp.wasm"), Generators: map[string][]byte{
			"cpp": read("wasm/capnpc-c++.wasm"), "rust": read("wasm/capnpc-rust.wasm"),
			"go": read("wasm/capnpc-go.wasm"), "zig": read("wasm/capnpc-zig.wasm"),
		},
	})
	if err != nil {
		panic(err)
	}
	defer compiler.Close(ctx)
	schema, err := os.ReadFile("schema.capnp")
	if err != nil {
		panic(err)
	}
	languages := []string{"cpp", "rust", "go", "zig"}
	result, err := compiler.Compile(ctx, capnpcwasm.Request{
		Files: map[string][]byte{"candidate.capnp": schema}, IncludeFiles: map[string][]byte{"go.capnp": read("include/go.capnp")},
		Entrypoints: []string{"candidate.capnp"}, Generators: languages,
	})
	if err != nil {
		panic(err)
	}
	regenerated, err := compiler.Generate(ctx, capnpcwasm.GenerationRequest{Request: result.Request, Generators: languages})
	if err != nil {
		panic(err)
	}
	digest := func(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }
	hashes := map[string]string{"request": digest(result.Request)}
	expected := map[string]string{"cpp": "candidate.capnp.h", "rust": "candidate_capnp.rs", "go": "candidate.capnp.go", "zig": "candidate.zig"}
	for language, files := range result.Outputs {
		if len(files[expected[language]]) == 0 {
			panic("missing output for " + language)
		}
		for name, data := range files {
			hash := digest(data)
			if digest(regenerated.Outputs[language][name]) != hash {
				panic("replay differs for " + name)
			}
			hashes[language+"/"+name] = hash
		}
	}
	encoded, err := json.Marshal(hashes)
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile("go-result.json", encoded, 0600); err != nil {
		panic(err)
	}
	fmt.Println("External Go compile and replay consumer passed")
}

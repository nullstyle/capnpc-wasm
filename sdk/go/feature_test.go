package capnpcwasm_test

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	capnpcwasm "github.com/nullstyle/capnpc-wasm/sdk/go"
)

func TestSchemaFeatures(t *testing.T) {
	r := root(t)
	fixtures := r + "/tests/fixtures/features"
	var manifest struct {
		Files     []string
		Scenarios []struct {
			Name        string
			Entrypoints []string
			Generators  []string
		}
	}
	if err := json.Unmarshal(read(t, fixtures+"/manifest.json"), &manifest); err != nil {
		t.Fatal(err)
	}
	if testing.Short() {
		t.Skip("native comparison of every feature scenario is skipped in short mode")
	}
	compiler := sharedCompiler(t)
	for _, scenario := range manifest.Scenarios {
		t.Run(scenario.Name, func(t *testing.T) {
			request := capnpcwasm.Request{
				Files: map[string][]byte{},
				IncludeFiles: map[string][]byte{
					"capnp/c++.capnp": read(t, r+"/ref/capnproto/c++/src/capnp/c++.capnp"),
					"go.capnp":        read(t, r+"/ref/go-capnp/std/go.capnp"),
				},
				Entrypoints: scenario.Entrypoints,
				Generators:  scenario.Generators,
			}
			for _, path := range manifest.Files {
				request.Files[path] = read(t, fixtures+"/workspace/"+path)
			}
			// Kept on failure or with CAPNP_KEEP_TEST_DIRS=1, removed otherwise.
			work := workDir(t, "go-features-"+scenario.Name+"-")
			for directory, files := range map[string]map[string][]byte{
				"src": request.Files, "include": request.IncludeFiles,
			} {
				for path, data := range files {
					destination := work + "/" + directory + "/" + path
					if err := os.MkdirAll(filepath.Dir(destination), 0755); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(destination, data, 0644); err != nil {
						t.Fatal(err)
					}
				}
			}
			args := []string{"compile", "--no-standard-import", "-I" + work + "/include", "--src-prefix=" + work + "/src", "-o-"}
			for _, entrypoint := range request.Entrypoints {
				args = append(args, work+"/src/"+entrypoint)
			}
			nativeRequest := command(t, "capnp", work, nil, args...)
			actual, err := compiler.Compile(t.Context(), request)
			if err != nil {
				t.Fatal(err)
			}
			if len(actual.Diagnostics) != 0 {
				t.Fatalf("unexpected SDK diagnostics: %+v", actual.Diagnostics)
			}
			t.Run("canonical full request", func(t *testing.T) {
				want := command(t, "normalize-request", work, nativeRequest)
				got := command(t, "normalize-request", work, actual.Request)
				if !bytes.Equal(got, want) {
					t.Fatal("canonical compiler request differs from native")
				}
			})
			for _, language := range request.Generators {
				t.Run(language+" generated source", func(t *testing.T) {
					dir := work + "/native-" + language
					if err := os.Mkdir(dir, 0755); err != nil {
						t.Fatal(err)
					}
					tool := "capnpc-" + language
					count := len(request.Entrypoints)
					if language == "cpp" {
						tool = "capnpc-c++"
						count *= 2
					}
					if stdout := command(t, tool, dir, nativeRequest); len(stdout) != 0 {
						t.Fatal("unexpected native generator stdout")
					}
					want := outputFiles(t, dir)
					if len(want) != count {
						t.Fatalf("native output count = %d, want %d", len(want), count)
					}
					if !reflect.DeepEqual(actual.Outputs[language], want) {
						t.Fatal("generated source differs from native")
					}
				})
			}
		})
	}
}

package capnpcwasm_test

import (
	"encoding/json"
	"reflect"
	"testing"

	capnpcwasm "github.com/nullstyle/capnpc-wasm/sdk/go"
)

// TestContractLimits pins DefaultLimits to the machine-readable contract that
// the TypeScript SDK asserts as well (docs/sdk-contract.md).
func TestContractLimits(t *testing.T) {
	var want map[string]int
	if err := json.Unmarshal(read(t, root(t)+"/tests/fixtures/contract/limits.json"), &want); err != nil {
		t.Fatal(err)
	}
	got := capnpcwasm.DefaultLimits().Named()
	if len(want) != 9 || !reflect.DeepEqual(got, want) {
		t.Fatalf("DefaultLimits = %v, contract = %v", got, want)
	}
}

func TestGeneratorCommandNames(t *testing.T) {
	for language, want := range map[capnpcwasm.Language]string{"cpp": "capnpc-c++", "rust": "capnpc-rust", "go": "capnpc-go", "zig": "capnpc-zig"} {
		if got := capnpcwasm.Argv0(language); got != want {
			t.Errorf("argv[0] for %s = %q, want %q", language, got, want)
		}
	}
}

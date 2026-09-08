@0xc997b57210ecf5b9;

using Cxx = import "/capnp/c++.capnp";
$Cxx.namespace("fixture");
using Common = import "types/common.capnp";

struct Person {
  id @0 :UInt64;
  name @1 :Text;
  addresses @2 :List(Common.Address);
  status @3 :Common.Status = active;
  union {
    absent @4 :Void;
    email @5 :Text;
  }
}

interface Directory {
  find @0 (id :UInt64) -> (person :Person);
}

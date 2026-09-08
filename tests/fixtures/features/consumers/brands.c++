#include "nested/brands.capnp.h"
#include <capnp/message.h>
#include <capnp/serialize.h>
#include <cassert>

void checkDefaults(feature_brands::Brands::Reader value) {
  assert(value.getText().getValue() == "branded 🦀");
  assert(value.getNested().getValue().getValue().getLabel() == "constant é");
  assert(value.getPair().getFirst() == "outer");
  const auto data = value.getPair().getSecond();
  assert(data.size() == 3 && data[0] == 0 && data[1] == 128 && data[2] == 255);
  const auto pointers = value.getPointers();
  assert(pointers.getAny().getAs<feature_test::Record>().getLabel() == "constant é");
  assert(pointers.getStructure().as<feature_test::Record>().getLabel() == "constant é");
  const auto list = pointers.getList().as<capnp::List<capnp::Text>>();
  assert(list.size() == 2 && list[0] == "first" && list[1] == "second");
}

int main() {
  capnp::MallocMessageBuilder message;
  auto value = message.initRoot<feature_brands::Brands>();
  checkDefaults(value.asReader());
  value.initUnbound().getValue().setAs<capnp::Text>("unbound pointer 🦀");
  auto words = capnp::messageToFlatArray(message);
  capnp::FlatArrayMessageReader decoded(words);
  auto result = decoded.getRoot<feature_brands::Brands>();
  checkDefaults(result);
  assert(result.getUnbound().getValue().getAs<capnp::Text>() == "unbound pointer 🦀");
}

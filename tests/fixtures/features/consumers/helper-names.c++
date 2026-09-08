#include "helper-names.capnp.h"
#include <capnp/message.h>
#include <capnp/serialize.h>
#include <cassert>

using namespace feature_helper_names;

int main() {
  {
    capnp::MallocMessageBuilder message;
    auto value = message.initRoot<WhichTag>();
    assert(value.which() == WhichTag::NONE);
    value.setNumber(123456789);
    auto words = capnp::messageToFlatArray(message);
    capnp::FlatArrayMessageReader decoded(words);
    auto reader = decoded.getRoot<WhichTag>();
    assert(reader.which() == WhichTag::NUMBER);
    assert(reader.getNumber() == 123456789);
  }
  {
    capnp::MallocMessageBuilder message;
    auto value = message.initRoot<EnumOrdinals>();
    value.setValue(EnumOrdinals::State::ACTIVE);
    auto words = capnp::messageToFlatArray(message);
    capnp::FlatArrayMessageReader decoded(words);
    assert(decoded.getRoot<EnumOrdinals>().getValue() == EnumOrdinals::State::ACTIVE);
  }
  {
    capnp::MallocMessageBuilder message;
    auto value = message.initRoot<NestedLists>();
    auto rows = value.initValues(2);
    auto numbers = rows.init(0, 3);
    numbers.set(0, 0);
    numbers.set(1, 123456789);
    numbers.set(2, 0xffffffff);
    rows.init(1, 0);
    auto words = capnp::messageToFlatArray(message);
    capnp::FlatArrayMessageReader decoded(words);
    auto result = decoded.getRoot<NestedLists>().getValues();
    assert(result.size() == 2 && result[0].size() == 3 && result[1].size() == 0);
    assert(result[0][0] == 0 && result[0][1] == 123456789 && result[0][2] == 0xffffffff);
  }
  {
    capnp::MallocMessageBuilder message;
    auto value = message.initRoot<PointerKinds>();
    auto payload = value.initValueAs<Payload>();
    payload.setNumber(42);
    payload.setText("helper name 🦀");
    auto words = capnp::messageToFlatArray(message);
    capnp::FlatArrayMessageReader decoded(words);
    auto result = decoded.getRoot<PointerKinds>().getValue().as<Payload>();
    assert(result.getNumber() == 42 && result.getText() == "helper name 🦀");
  }
  {
    capnp::MallocMessageBuilder message;
    auto value = message.initRoot<GroupViews>();
    value.setValue(GroupViews::State::ONE);
    value.getEnumOrdinals().setNumber(123456789);
    auto words = capnp::messageToFlatArray(message);
    capnp::FlatArrayMessageReader decoded(words);
    auto result = decoded.getRoot<GroupViews>();
    assert(result.getValue() == GroupViews::State::ONE);
    assert(result.getEnumOrdinals().getNumber() == 123456789);
  }
}

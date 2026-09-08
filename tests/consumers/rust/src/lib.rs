pub mod common_capnp {
    include!(concat!(
        env!("CAPNPC_WASM_GENERATED_DIR"),
        "/types/common_capnp.rs"
    ));
}

pub mod person_capnp {
    include!(concat!(
        env!("CAPNPC_WASM_GENERATED_DIR"),
        "/person_capnp.rs"
    ));
}

#[cfg(test)]
mod tests {
    use super::{common_capnp, person_capnp};

    #[test]
    fn generated_person_roundtrips() -> Result<(), Box<dyn std::error::Error>> {
        const ID: u64 = 0xfedc_ba98_7654_3210;
        let mut message = capnp::message::Builder::new_default();
        {
            let mut person = message.init_root::<person_capnp::person::Builder<'_>>();
            assert!(matches!(
                person.reborrow_as_reader().which()?,
                person_capnp::person::Which::Absent(())
            ));
            person.set_id(ID);
            person.set_name("Zoë 🦀");
            person.set_email("zoë@example.test");
            let mut addresses = person.init_addresses(1);
            addresses.reborrow().get(0).set_city("Tromsø");
            // Leave the status and country unset to exercise schema defaults.
        }

        let bytes = capnp::serialize::write_message_to_words(&message);
        let mut input = bytes.as_slice();
        let decoded = capnp::serialize::read_message_from_flat_slice(
            &mut input,
            capnp::message::ReaderOptions::new(),
        )?;
        assert!(input.is_empty());
        let person = decoded.get_root::<person_capnp::person::Reader<'_>>()?;
        assert_eq!(person.get_id(), ID);
        assert_eq!(person.get_name()?.to_str()?, "Zoë 🦀");
        assert_eq!(person.get_status()?, common_capnp::Status::Active);
        let addresses = person.get_addresses()?;
        assert_eq!(addresses.len(), 1);
        let address = addresses.get(0);
        assert_eq!(address.get_city()?.to_str()?, "Tromsø");
        assert_eq!(address.get_country()?.to_str()?, "US");
        match person.which()? {
            person_capnp::person::Which::Email(email) => {
                assert_eq!(email?.to_str()?, "zoë@example.test");
            }
            person_capnp::person::Which::Absent(()) => panic!("email union arm was lost"),
        }
        Ok(())
    }
}

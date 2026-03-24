pub mod discuz {
    diesel::table! {
        discuz.common_member_profile (uid) {
            uid -> Int4,
            gender -> Int2,
        }
    }
}

mod file_uploads_rust;

#[cfg(test)]
mod tests {
    use super::file_uploads_rust::*;

    #[test]
    fn test_exe_rejected_by_magic_bytes() {
        file_uploads_rust::tests::test_exe_rejected_by_magic_bytes();
    }

    #[test]
    fn test_png_accepted_and_stored_under_generated_name() {
        file_uploads_rust::tests::test_png_accepted_and_stored_under_generated_name();
    }

    #[test]
    fn test_path_traversal_sanitized() {
        file_uploads_rust::tests::test_path_traversal_sanitized();
    }

    #[test]
    fn test_file_over_size_limit_rejected() {
        file_uploads_rust::tests::test_file_over_size_limit_rejected();
    }

    #[test]
    fn test_non_member_cannot_upload_or_download() {
        file_uploads_rust::tests::test_non_member_cannot_upload_or_download();
    }

    #[test]
    fn test_expired_link_rejected() {
        file_uploads_rust::tests::test_expired_link_rejected();
    }

    #[test]
    fn test_link_with_changed_character_rejected() {
        file_uploads_rust::tests::test_link_with_changed_character_rejected();
    }

    #[test]
    fn test_after_delete_file_can_no_longer_be_linked_or_downloaded() {
        file_uploads_rust::tests::test_after_delete_file_can_no_longer_be_linked_or_downloaded();
    }
}
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using FileUploads;

namespace FileUploadsTests
{
    public static class Tests
    {
        private static readonly byte[] HmacKey = Encoding.UTF8.GetBytes("test-secret-key-123456-7890-abcdef");

        private static void Assert(bool condition, string message)
        {
            if (!condition) throw new Exception("Assertion failed: " + message);
        }

        private static void AssertThrows<T>(Action action, string message) where T : Exception
        {
            try
            {
                action();
                throw new Exception("Expected exception not thrown: " + message);
            }
            catch (T) { }
            catch (Exception ex)
            {
                throw new Exception($"Unexpected exception type: {ex.GetType()}, message: {ex.Message}");
            }
        }

        private static FileUploadService CreateService(out InMemoryFileStore store, out string storageDir, out HashSet<string> members, long sizeLimitBytes = 10 * 1024 * 1024)
        {
            store = new InMemoryFileStore();
            storageDir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
            HashSet<string> membersSet = new HashSet<string>();
            members = membersSet;
            Func<Guid, Guid, bool> isMember = (u, o) => membersSet.Contains($"{u}:{o}");
            return new FileUploadService(store, storageDir, HmacKey, isMember, sizeLimitBytes);
        }

        private static void CleanupDirectory(string dir)
        {
            try
            {
                if (Directory.Exists(dir))
                {
                    Directory.Delete(dir, true);
                }
            }
            catch { }
        }

        public static void TestExeRejection()
        {
            var user = Guid.NewGuid();
            var org = Guid.NewGuid();
            var svc = CreateService(out var store, out var dir, out var members);
            try
            {
                members.Add($"{user}:{org}");

                byte[] exeBytes = new byte[] { 0x4D, 0x5A, 0x90, 0x00 }; // MZ header
                AssertThrows<FileUploadException>(() => svc.Upload(user, org, "malware.exe", exeBytes, "application/octet-stream"),
                    "exe should be rejected");
                // rename to .png but still exe bytes
                AssertThrows<FileUploadException>(() => svc.Upload(user, org, "malware.png", exeBytes, "image/png"),
                    "png with exe bytes should be rejected");
            }
            finally
            {
                CleanupDirectory(dir);
            }
        }

        public static void TestPngAccepted()
        {
            var user = Guid.NewGuid();
            var org = Guid.NewGuid();
            var svc = CreateService(out var store, out var dir, out var members);
            try
            {
                members.Add($"{user}:{org}");

                byte[] pngBytes = new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A };
                Guid fileId = svc.Upload(user, org, "image.png", pngBytes, "image/png");
                var record = store.GetFile(fileId);
                Assert(record != null, "Record should exist");
                Assert(record.StoredName != "image.png", "Stored name should be generated");
                Assert(record.OriginalName == "image.png", "Original name preserved");
            }
            finally
            {
                CleanupDirectory(dir);
            }
        }

        public static void TestPathSanitization()
        {
            var user = Guid.NewGuid();
            var org = Guid.NewGuid();
            var svc = CreateService(out var store, out var dir, out var members);
            try
            {
                members.Add($"{user}:{org}");

                byte[] pngBytes = new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A };
                Guid fileId = svc.Upload(user, org, "../../etc/passwd.png", pngBytes, "image/png");
                var record = store.GetFile(fileId);
                Assert(record != null, "Record should exist");
                Assert(!record.OriginalName.Contains(".."), "Original name should not contain path parts");
                Assert(!record.OriginalName.Contains("/"), "Original name should not contain slashes");
                Assert(!record.OriginalName.Contains("\\"), "Original name should not contain backslashes");
            }
            finally
            {
                CleanupDirectory(dir);
            }
        }

        public static void TestSizeLimit()
        {
            var user = Guid.NewGuid();
            var org = Guid.NewGuid();
            var svc = CreateService(out var store, out var dir, out var members, sizeLimitBytes: 100);
            try
            {
                members.Add($"{user}:{org}");

                byte[] big = new byte[101];
                AssertThrows<FileUploadException>(() => svc.Upload(user, org, "big.png", big, "image/png"),
                    "File over size limit should be rejected");
            }
            finally
            {
                CleanupDirectory(dir);
            }
        }

        public static void TestNonMemberAccess()
        {
            var user = Guid.NewGuid();
            var org = Guid.NewGuid();
            var svc = CreateService(out var store, out var dir, out var members);
            try
            {
                members.Add($"{user}:{org}");

                byte[] pngBytes = new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A };
                Guid fileId = svc.Upload(user, org, "image.png", pngBytes, "image/png");

                var otherUser = Guid.NewGuid();
                AssertThrows<FileUploadException>(() => svc.Upload(otherUser, org, "image.png", pngBytes, "image/png"),
                    "Non-member should not upload");

                AssertThrows<FileUploadException>(() => svc.CreateDownloadLink(otherUser, fileId),
                    "Non-member should not get link");

                AssertThrows<FileUploadException>(() => svc.DeleteFile(otherUser, fileId),
                    "Non-member should not delete");

                string token = svc.CreateDownloadLink(user, fileId);
                members.Remove($"{user}:{org}");
                AssertThrows<FileUploadException>(() => svc.Download(token),
                    "Removed member should not download");
            }
            finally
            {
                CleanupDirectory(dir);
            }
        }

        public static void TestExpiredLink()
        {
            var user = Guid.NewGuid();
            var org = Guid.NewGuid();
            var svc = CreateService(out var store, out var dir, out var members);
            try
            {
                members.Add($"{user}:{org}");

                byte[] pngBytes = new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A };
                Guid fileId = svc.Upload(user, org, "image.png", pngBytes, "image/png");
                string token = svc.CreateDownloadLink(user, fileId, ttlSeconds: 1);
                System.Threading.Thread.Sleep(2000); // wait for expiry
                AssertThrows<FileUploadException>(() => svc.Download(token),
                    "Expired link should be rejected");

                string validToken = svc.CreateDownloadLink(user, fileId, ttlSeconds: 300);
                string tampered = validToken.Substring(0, validToken.Length - 1) + (validToken.EndsWith("A") ? "B" : "A");
                AssertThrows<FileUploadException>(() => svc.Download(tampered),
                    "Tampered link should be rejected");
            }
            finally
            {
                CleanupDirectory(dir);
            }
        }

        public static void TestDeletePreventsAccess()
        {
            var user = Guid.NewGuid();
            var org = Guid.NewGuid();
            var svc = CreateService(out var store, out var dir, out var members);
            try
            {
                members.Add($"{user}:{org}");

                byte[] pngBytes = new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A };
                Guid fileId = svc.Upload(user, org, "image.png", pngBytes, "image/png");
                string token = svc.CreateDownloadLink(user, fileId);
                svc.DeleteFile(user, fileId);

                AssertThrows<FileUploadException>(() => svc.CreateDownloadLink(user, fileId),
                    "Link creation after delete should fail");
                AssertThrows<FileUploadException>(() => svc.Download(token),
                    "Download after delete should fail");
            }
            finally
            {
                CleanupDirectory(dir);
            }
        }

        public static int Main()
        {
            int failures = 0;
            Action[] tests = new Action[]
            {
                TestExeRejection,
                TestPngAccepted,
                TestPathSanitization,
                TestSizeLimit,
                TestNonMemberAccess,
                TestExpiredLink,
                TestDeletePreventsAccess
            };

            foreach (var test in tests)
            {
                try
                {
                    test();
                    Console.WriteLine($"{test.Method.Name}: PASS");
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"{test.Method.Name}: FAIL - {ex.Message}");
                    failures++;
                }
            }

            return failures > 0 ? 1 : 0;
        }
    }
}
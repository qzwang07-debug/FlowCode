// SPDX-License-Identifier: MIT
// Copyright (c) 2026 FlowCode contributors

using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace FlowCode.BrowserBridge
{
    [DataContract]
    internal sealed class RegistrationConfig
    {
        [DataMember(Name = "schemaVersion")]
        public int SchemaVersion { get; set; }

        [DataMember(Name = "desktopExecutable")]
        public string DesktopExecutable { get; set; }

        [DataMember(Name = "clients")]
        public ClientConfig[] Clients { get; set; }
    }

    [DataContract]
    internal sealed class ClientConfig
    {
        [DataMember(Name = "browser")]
        public string Browser { get; set; }

        [DataMember(Name = "nativeHost")]
        public string NativeHost { get; set; }

        [DataMember(Name = "origin")]
        public string Origin { get; set; }
    }

    [DataContract]
    internal sealed class RuntimeConfig
    {
        [DataMember(Name = "schemaVersion")]
        public int SchemaVersion { get; set; }

        [DataMember(Name = "endpoint")]
        public string Endpoint { get; set; }

        [DataMember(Name = "token")]
        public string Token { get; set; }

        [DataMember(Name = "maxMessageBytes")]
        public int MaxMessageBytes { get; set; }
    }

    [DataContract]
    internal sealed class ConnectMessage
    {
        [DataMember(Name = "kind")]
        public string Kind { get; set; }

        [DataMember(Name = "protocolVersion")]
        public int ProtocolVersion { get; set; }

        [DataMember(Name = "token")]
        public string Token { get; set; }

        [DataMember(Name = "origin")]
        public string Origin { get; set; }
    }

    [DataContract]
    internal sealed class ErrorMessage
    {
        [DataMember(Name = "kind")]
        public string Kind { get; set; }

        [DataMember(Name = "protocolVersion")]
        public int ProtocolVersion { get; set; }

        [DataMember(Name = "code")]
        public string Code { get; set; }

        [DataMember(Name = "message")]
        public string Message { get; set; }
    }

    internal static class Program
    {
        private const int ProtocolVersion = 1;
        private const int MaximumMessageBytes = 256 * 1024;
        private const string RegistrationFile = "browser-bridge-registration.json";
        private const string RuntimeFile = "browser-bridge-runtime.json";

        public static int Main(string[] args)
        {
            try
            {
                return RunAsync(args).GetAwaiter().GetResult();
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("[FlowCode:BrowserHost] " + error.Message);
                return 1;
            }
        }

        private static async Task<int> RunAsync(string[] args)
        {
            string origin = args.FirstOrDefault(value =>
                value.StartsWith("chrome-extension://", StringComparison.Ordinal));
            if (String.IsNullOrEmpty(origin))
            {
                throw new InvalidDataException("The browser did not supply an extension origin.");
            }

            string directory = AppDomain.CurrentDomain.BaseDirectory;
            string registrationPath = Path.Combine(directory, RegistrationFile);
            RegistrationConfig registration = ReadJson<RegistrationConfig>(registrationPath);
            ValidateRegistration(registration, origin);

            NamedPipeClientStream pipe = await ConnectDesktopAsync(directory, registration);
            if (pipe == null)
            {
                WriteNativeMessage(new ErrorMessage
                {
                    Kind = "bridge.error",
                    ProtocolVersion = ProtocolVersion,
                    Code = "desktop-unavailable",
                    Message = "FlowCode Desktop is unavailable."
                });
                return 2;
            }

            using (pipe)
            {
                RuntimeConfig runtime = ReadJson<RuntimeConfig>(Path.Combine(directory, RuntimeFile));
                ValidateRuntime(runtime);
                byte[] connectPayload = SerializeJson(new ConnectMessage
                {
                    Kind = "bridge.connect",
                    ProtocolVersion = ProtocolVersion,
                    Token = runtime.Token,
                    Origin = origin
                });
                await WriteFrameAsync(pipe, connectPayload, runtime.MaxMessageBytes, CancellationToken.None);

                using (CancellationTokenSource cancellation = new CancellationTokenSource())
                {
                    Task browserToDesktop = PumpAsync(
                        Console.OpenStandardInput(),
                        pipe,
                        runtime.MaxMessageBytes,
                        cancellation.Token);
                    Task desktopToBrowser = PumpAsync(
                        pipe,
                        Console.OpenStandardOutput(),
                        runtime.MaxMessageBytes,
                        cancellation.Token);
                    Task completed = await Task.WhenAny(browserToDesktop, desktopToBrowser);
                    try
                    {
                        await completed;
                    }
                    finally
                    {
                        cancellation.Cancel();
                    }
                }
            }
            return 0;
        }

        private static async Task<NamedPipeClientStream> ConnectDesktopAsync(
            string directory,
            RegistrationConfig registration)
        {
            bool desktopStarted = false;
            for (int attempt = 0; attempt < 50; attempt++)
            {
                try
                {
                    RuntimeConfig runtime = ReadJson<RuntimeConfig>(Path.Combine(directory, RuntimeFile));
                    ValidateRuntime(runtime);
                    string prefix = @"\\.\pipe\";
                    if (!runtime.Endpoint.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                    {
                        throw new InvalidDataException("The bridge endpoint is not a local Windows pipe.");
                    }
                    string pipeName = runtime.Endpoint.Substring(prefix.Length);
                    NamedPipeClientStream pipe = new NamedPipeClientStream(
                        ".",
                        pipeName,
                        PipeDirection.InOut,
                        PipeOptions.Asynchronous);
                    pipe.Connect(250);
                    return pipe;
                }
                catch (Exception error)
                {
                    if (!(error is IOException) &&
                        !(error is TimeoutException) &&
                        !(error is FileNotFoundException) &&
                        !(error is InvalidDataException))
                    {
                        throw;
                    }
                }

                if (!desktopStarted)
                {
                    StartDesktop(registration.DesktopExecutable);
                    desktopStarted = true;
                }
                await Task.Delay(100);
            }
            return null;
        }

        private static void StartDesktop(string executable)
        {
            if (String.IsNullOrWhiteSpace(executable) || !File.Exists(executable)) return;
            Process.Start(new ProcessStartInfo
            {
                FileName = executable,
                Arguments = "--flowcode-browser-wakeup",
                WorkingDirectory = Path.GetDirectoryName(executable),
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            });
        }

        private static async Task PumpAsync(
            Stream input,
            Stream output,
            int maxMessageBytes,
            CancellationToken cancellation)
        {
            byte[] prefix = new byte[4];
            while (!cancellation.IsCancellationRequested)
            {
                int prefixBytes = await ReadExactAsync(input, prefix, 4, cancellation);
                if (prefixBytes == 0) return;
                if (prefixBytes != 4) throw new EndOfStreamException("Incomplete native message prefix.");
                int length = BitConverter.ToInt32(prefix, 0);
                if (length < 1 || length > maxMessageBytes)
                {
                    throw new InvalidDataException("Native message exceeds the FlowCode size limit.");
                }
                byte[] payload = new byte[length];
                if (await ReadExactAsync(input, payload, length, cancellation) != length)
                {
                    throw new EndOfStreamException("Incomplete native message payload.");
                }
                await output.WriteAsync(prefix, 0, prefix.Length, cancellation);
                await output.WriteAsync(payload, 0, payload.Length, cancellation);
                await output.FlushAsync(cancellation);
            }
        }

        private static async Task<int> ReadExactAsync(
            Stream stream,
            byte[] buffer,
            int length,
            CancellationToken cancellation)
        {
            int offset = 0;
            while (offset < length)
            {
                int read = await stream.ReadAsync(buffer, offset, length - offset, cancellation);
                if (read == 0) return offset;
                offset += read;
            }
            return offset;
        }

        private static async Task WriteFrameAsync(
            Stream output,
            byte[] payload,
            int maxMessageBytes,
            CancellationToken cancellation)
        {
            if (payload.Length < 1 || payload.Length > maxMessageBytes)
            {
                throw new InvalidDataException("Native message exceeds the FlowCode size limit.");
            }
            byte[] prefix = BitConverter.GetBytes(payload.Length);
            await output.WriteAsync(prefix, 0, prefix.Length, cancellation);
            await output.WriteAsync(payload, 0, payload.Length, cancellation);
            await output.FlushAsync(cancellation);
        }

        private static void WriteNativeMessage<T>(T value)
        {
            byte[] payload = SerializeJson(value);
            Stream output = Console.OpenStandardOutput();
            byte[] prefix = BitConverter.GetBytes(payload.Length);
            output.Write(prefix, 0, prefix.Length);
            output.Write(payload, 0, payload.Length);
            output.Flush();
        }

        private static byte[] SerializeJson<T>(T value)
        {
            DataContractJsonSerializer serializer = new DataContractJsonSerializer(typeof(T));
            using (MemoryStream stream = new MemoryStream())
            {
                serializer.WriteObject(stream, value);
                return stream.ToArray();
            }
        }

        private static T ReadJson<T>(string file)
        {
            using (FileStream stream = File.OpenRead(file))
            {
                DataContractJsonSerializer serializer = new DataContractJsonSerializer(typeof(T));
                return (T)serializer.ReadObject(stream);
            }
        }

        private static void ValidateRegistration(RegistrationConfig config, string origin)
        {
            if (config == null || config.SchemaVersion != 1 || config.Clients == null ||
                config.Clients.Length != 2 || !config.Clients.Any(client => client.Origin == origin))
            {
                throw new InvalidDataException("The extension origin is not authorized.");
            }
        }

        private static void ValidateRuntime(RuntimeConfig runtime)
        {
            if (runtime == null || runtime.SchemaVersion != 1 ||
                runtime.MaxMessageBytes != MaximumMessageBytes ||
                String.IsNullOrWhiteSpace(runtime.Endpoint) ||
                String.IsNullOrWhiteSpace(runtime.Token) || runtime.Token.Length != 64)
            {
                throw new InvalidDataException("The FlowCode bridge runtime configuration is invalid.");
            }
        }
    }
}

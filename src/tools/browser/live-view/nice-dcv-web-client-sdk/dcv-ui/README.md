# Amazon DCV Web UI SDK

The Amazon DCV Web UI SDK is a JavaScript library exposing a single
React component that provides the user interface to interact with
the Amazon DCV Web Client in-session experience.
Users are still responsible for the authentication against the Amazon DCV Server,
before connecting to a Amazon DCV session and use the `DCVViewer` React component.

## Prerequisites

Before you start working with the Amazon DCV Web UI SDK, ensure
that you're familiar with Amazon DCV and Amazon DCV sessions. For more
information, see the [Amazon DCV Administrator Guide](https://docs.aws.amazon.com/dcv/latest/adminguide).

The Amazon DCV Web UI SDK supports Amazon DCV server version 2020
and later.

## Browser Support

The Amazon DCV Web UI SDK supports JavaScript (ES6) and it can
be used from JavaScript or TypeScript applications.

The Amazon DCV Web UI SDK supports the following web browsers:
 * Google Chrome - Latest three major versions
 * Mozilla Firefox - Latest three major versions
 * Microsoft Edge - Latest three major versions
 * Apple Safari for macOS - Latest three major versions

Even if the SDK is designed to work with latest browsers versions,
it can be transpiled to ES5 code and used with older browser. In
this case some features or functionalities may be not available.

## Versioning

The Amazon DCV Web UI SDK follows the semantic versioning model.
Version has the following format: major.minor.patch. A change in
the major version, such as from 1.x.x to 2.x.x, indicates that breaking
changes that might require code changes and a planned deployment
have been introduced. A change in the minor version, such as from
1.1.x to 1.2.x, is backwards compatible, but might include
deprecated elements.

## How to use the library

The SDK reference, and some examples are available in the
[official documentation website](https://docs.aws.amazon.com/dcv/latest/websdkguide).

## License

For the license see the file EULA.txt.
For the Third party notices see the file third-party-licenses.txt.

Please beware that the `DCVViewer` React component expects these two files
to be present in the URL path for the embedded web server.
The third-party-licenses.txt should be modified to include the content of the
corresponding file from Amazon DCV Web SDK package and possibly any other license
information from the libraries used by the consuming application.
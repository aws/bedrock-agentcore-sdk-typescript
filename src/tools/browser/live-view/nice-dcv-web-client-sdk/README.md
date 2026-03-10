# Amazon DCV Web SDK

## Amazon DCV

Amazon DCV is a high-performance remote display protocol. It lets you securely deliver
remote desktops and application streaming from any cloud or data center to any device,
over varying network conditions. By using Amazon DCV with Amazon EC2, you can run graphics-intensive
applications remotely on Amazon EC2 instances. You can then stream the results to
more modest client machines, which eliminates the need for expensive dedicated workstations.

## Amazon DCV Web Client SDK

The Amazon DCV Web Client SDK is a JavaScript library that you can use to develop your
own Amazon DCV web browser client applications. Your end users can use these applications
to connect to and interact with a running Amazon DCV session.

This library is exported in both ESM and UMD formats within the corresponding folders.

## Amazon DCV Web UI SDK

The Amazon DCV Web UI SDK is a JavaScript library exposing a single React component that
provides the user interface to interact with the Amazon DCV Web Client in-session experience.

Users are still responsible for the authentication against the Amazon DCV Server,
before connecting to a Amazon DCV session and use the `DCVViewer` React component.
Hence, users of this library should also import the Amazon DCV Web Client SDK in their React applications.
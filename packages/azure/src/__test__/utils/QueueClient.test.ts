/*
Copyright (c) Walmart Inc.

This source code is licensed under the Apache 2.0 license found in the
LICENSE file in the root directory of this source tree.
*/

import { config, EventSourcedMetadata, JsonMessageEncoder } from "@walmartlabs/cookie-cutter-core";
import { createQueueService, LinearRetryPolicyFilter, QueueService } from "azure-storage";
import { MockTracer, Span, SpanContext } from "opentracing";
import { IQueueConfiguration, IQueueSourceConfiguration, QueueMetadata } from "../../streaming";
import { QueueConfiguration, QueueSourceConfiguration } from "../../streaming/internal";
import { EnvelopeQueueMessagePreprocessor, QueueClient } from "../../utils";

jest.mock("azure-storage", () => {
    return {
        createQueueService: jest.fn(),
        LinearRetryPolicyFilter: jest.fn(),
    };
});

const MockCreateQueueService: jest.Mock = createQueueService as any;
const MockLinearRetryPolicyFilter: jest.Mock = LinearRetryPolicyFilter as any;

const withFilter = function(this: QueueService) {
    return this;
};

describe("QueueClient", () => {
    const rawConfiguration = {
        queueName: "queue123",
        storageAccount: "myAccount",
        storageAccessKey: "myKey",
        encoder: new JsonMessageEncoder(),
        retryInterval: "5s",
        retryCount: 3,
        preprocessor: new EnvelopeQueueMessagePreprocessor(),
    } as any;
    const parseConfig = (raw: any): IQueueConfiguration => config.parse(QueueConfiguration, raw);
    const configuration = parseConfig(rawConfiguration);
    const context = new SpanContext();
    const span: Span = new MockTracer().startSpan("unit-test", { childOf: context });
    const payload = "hello world to queues";
    const headers = {
        [EventSourcedMetadata.EventType]: "foo",
    };
    const messageQueueResult = {
        messageId: "message123",
        popReceipt: "pop123",
        messageText: JSON.stringify({ headers, payload }),
    };

    beforeEach(() => {
        MockCreateQueueService.mockReset();
        MockLinearRetryPolicyFilter.mockReset();
    });

    describe("constructor", () => {
        it("should use retry filter by default", async () => {
            const withFilter = jest.fn();
            const filter = { t: "me" };
            MockLinearRetryPolicyFilter.mockImplementation(() => filter);
            MockCreateQueueService.mockImplementation(() => ({
                withFilter,
            }));
            const client = new QueueClient(configuration);
            expect(client).toBeDefined();
            expect(withFilter).toBeCalledWith(filter);
        });

        it("should not use retry if retry count is 0", async () => {
            const withFilter = jest.fn();
            MockCreateQueueService.mockImplementation(() => ({
                withFilter,
            }));
            const client = new QueueClient({ ...configuration, retryCount: 0 });
            expect(client).toBeDefined();
            expect(withFilter).not.toBeCalled();
        });

        it("should pass in defaults to retry constructor", async () => {
            const withFilter = jest.fn();
            const filter = { t: "me" };
            MockLinearRetryPolicyFilter.mockImplementation(() => filter);
            MockCreateQueueService.mockImplementation(() => ({
                withFilter,
            }));
            const client = new QueueClient(configuration);
            expect(client).toBeDefined();
            expect(MockLinearRetryPolicyFilter).toHaveBeenCalledWith(3, 5000);
        });

        it("should pass config specified values", async () => {
            const withFilter = jest.fn();
            const filter = { t: "me" };
            MockLinearRetryPolicyFilter.mockImplementation(() => filter);
            MockCreateQueueService.mockImplementation(() => ({
                withFilter,
            }));
            const client = new QueueClient({ ...configuration, retryCount: 1, retryInterval: 1 });
            expect(client).toBeDefined();
            expect(MockLinearRetryPolicyFilter).toHaveBeenCalledWith(1, 1);
        });
    });

    describe("write", () => {
        const response = { statusCode: 200 };
        const writeResultsIn = async (
            error?: any,
            result?: any,
            res = response,
            config = configuration
        ) => {
            const createMessage = jest.fn();
            const createQueueIfNotExists = jest.fn();
            createMessage.mockImplementationOnce((_q, _t, _o, cb) => {
                cb(error, result, res);
            });
            createQueueIfNotExists.mockImplementation((_q, cb) => {
                cb(undefined, { created: true, exists: true });
            });
            MockCreateQueueService.mockImplementation(() => ({
                createMessage,
                withFilter,
                createQueueIfNotExists,
            }));
            const client = new QueueClient(config);
            return { createMessage, client, createQueueIfNotExists };
        };
        it("should write message with defaults", async () => {
            const { client, createMessage } = await writeResultsIn(undefined, messageQueueResult);
            const result = await client.write(span.context(), payload, headers);
            expect(result).toBeDefined();
            expect(createMessage).toBeCalledWith(
                configuration.queueName,
                JSON.stringify({ payload, headers }),
                undefined,
                expect.anything()
            );
        });
        it("should write message with options", async () => {
            const { client, createMessage } = await writeResultsIn(undefined, messageQueueResult);
            const options = {
                queueName: "different",
                visibilityTimeout: 1233,
                messageTimeToLive: 124,
            };
            await client.write(span.context(), payload, headers, options);
            expect(createMessage).toBeCalledWith(
                options.queueName,
                JSON.stringify({ payload, headers }),
                options,
                expect.anything()
            );
        });
        it("should pass client failure up", async () => {
            const error = new Error("something bad happend");
            const { client } = await writeResultsIn(error);
            await expect(client.write(span.context(), payload, headers)).rejects.toEqual(error);
        });
        it("should error if text is to big", async () => {
            const bigText = Buffer.alloc(65 * 1024);
            const { client, createMessage } = await writeResultsIn();
            const result = client.write(span.context(), bigText, headers);
            expect(createMessage).not.toBeCalled();
            await expect(result).rejects.toEqual(
                new Error("Queue Message too big, must be less then 64kb. is: 173.423828125")
            );
        });
        it("should error get back 413 from azure", async () => {
            const bigText = Buffer.alloc(1024);
            const e: Error & { statusCode?: number } = new Error(
                "The request body is too large and exceeds the maximum permissible limit."
            );
            const { client, createMessage } = await writeResultsIn(e, undefined, {
                statusCode: 413,
            });
            const result = client.write(span.context(), bigText, headers);
            expect(createMessage).toBeCalled();
            await expect(result).rejects.toMatchObject({ code: 413 });
        });
        it("should retry on 404s if configured to", async () => {
            const serviceResponse = { statusCode: 404 };
            const { client, createMessage, createQueueIfNotExists } = await writeResultsIn(
                new Error(),
                undefined,
                serviceResponse,
                parseConfig({ ...rawConfiguration, createQueueIfNotExists: true })
            );
            createMessage.mockImplementationOnce((_q, _t, _o, cb) => {
                cb(undefined, {}, { statusCode: 200 });
            });
            const result = await client.write(span.context(), payload, headers);
            expect(createMessage).toBeCalledTimes(2);
            expect(createQueueIfNotExists).toBeCalled();
            expect(result).toBeDefined();
        });
        it("should not retry on 404s if not configured to", async () => {
            const serviceResponse = { statusCode: 404 };
            const { client, createMessage, createQueueIfNotExists } = await writeResultsIn(
                new Error(),
                undefined,
                serviceResponse,
                parseConfig({ ...rawConfiguration, createQueueIfNotExists: false })
            );
            createMessage.mockImplementationOnce((_q, _t, _o, cb) => {
                cb(undefined, {}, { statusCode: 200 });
            });
            const result = client.write(span.context(), payload, headers);
            await expect(result).rejects.toMatchObject({ code: 404 });
            expect(createQueueIfNotExists).not.toBeCalled();
            expect(createMessage).toBeCalledTimes(1);
        });
        it("should not retry on other errors (even if configured to)", async () => {
            const serviceResponse = { statusCode: 401 };
            const { client, createMessage, createQueueIfNotExists } = await writeResultsIn(
                new Error(),
                undefined,
                serviceResponse,
                parseConfig({ ...rawConfiguration, createQueueIfNotExists: true })
            );
            createMessage.mockImplementationOnce((_q, _t, _o, cb) => {
                cb(undefined, {}, { statusCode: 200 });
            });
            const result = client.write(span.context(), payload, headers);
            await expect(result).rejects.toMatchObject({ code: 401 });
            expect(createQueueIfNotExists).not.toBeCalled();
            expect(createMessage).toBeCalledTimes(1);
        });
    });
    describe("read", () => {
        const response = { statusCode: 200 };
        const readResultsIn = async (error?: any, result?: any) => {
            const getMessages = jest.fn();
            getMessages.mockImplementation((_q, _o, cb) => {
                cb(error, result, response);
            });
            MockCreateQueueService.mockImplementation(() => ({
                getMessages,
                withFilter,
            }));
            const client = new QueueClient(configuration);
            return { getMessages, client };
        };
        it("should read messages with defaults", async () => {
            const { client, getMessages } = await readResultsIn(undefined, [messageQueueResult]);
            const messages = await client.read(span.context());
            expect(messages).toHaveLength(1);
            expect(messages[0].headers[QueueMetadata.MessageId]).toBe(messageQueueResult.messageId);
            expect(getMessages).toBeCalledWith(
                configuration.queueName,
                { numOfMessages: undefined, visibilityTimeout: undefined },
                expect.anything()
            );
        });
        it("should read messages with options", async () => {
            const { client, getMessages } = await readResultsIn(undefined, [messageQueueResult]);
            let options: IQueueConfiguration & IQueueSourceConfiguration = {
                storageAccount: "storageAcc",
                storageAccessKey: "storageKey",
                queueName: "different",
                createQueueIfNotExists: false,
                encoder: new JsonMessageEncoder(),
                numOfMessages: 20,
                visibilityTimeout: 60000,
            };
            options = config.parse(QueueSourceConfiguration, options, {
                retryCount: 3,
                retryInterval: 5000,
                largeItemBlobContainer: "queue-large-items",
                createQueueIfNotExists: false,
                preprocessor: new EnvelopeQueueMessagePreprocessor(),
            });
            await client.read(span.context(), options);
            expect(getMessages).toBeCalledWith(
                options.queueName,
                {
                    numOfMessages: options.numOfMessages,
                    visibilityTimeout: options.visibilityTimeout,
                },
                expect.anything()
            );
        });
        it("should raise error", async () => {
            const error = new Error("ME");
            const { client } = await readResultsIn(error);
            const result = client.read(span.context());
            await expect(result).rejects.toEqual(error);
        });
    });
    describe("markAsProcessed", () => {
        const response = { statusCode: 200 };
        const markAsProcessedResultsIn = async (error?: any) => {
            const deleteMessage = jest.fn();
            deleteMessage.mockImplementation((_q, _m, _p, cb) => {
                cb(error, response);
            });
            MockCreateQueueService.mockImplementation(() => ({
                deleteMessage,
                withFilter,
            }));
            const client = new QueueClient(configuration);
            return { deleteMessage, client };
        };
        it("should delete message when processed with default queue name", async () => {
            const { client, deleteMessage } = await markAsProcessedResultsIn();
            await client.markAsProcessed(
                span.context(),
                messageQueueResult.messageId,
                messageQueueResult.popReceipt
            );
            expect(deleteMessage).toBeCalledWith(
                configuration.queueName,
                messageQueueResult.messageId,
                messageQueueResult.popReceipt,
                expect.anything()
            );
        });
        it("should delete message when processed with different queue name", async () => {
            const { client, deleteMessage } = await markAsProcessedResultsIn();
            const options = { queueName: "different" };
            await client.markAsProcessed(
                span.context(),
                messageQueueResult.messageId,
                messageQueueResult.popReceipt,
                options.queueName
            );
            expect(deleteMessage).toBeCalledWith(
                options.queueName,
                messageQueueResult.messageId,
                messageQueueResult.popReceipt,
                expect.anything()
            );
        });
        it("should raise error", async () => {
            const error = new Error("ME");
            const { client } = await markAsProcessedResultsIn(error);
            const result = client.markAsProcessed(
                span.context(),
                messageQueueResult.messageId,
                messageQueueResult.popReceipt
            );
            await expect(result).rejects.toEqual(error);
        });
    });
});

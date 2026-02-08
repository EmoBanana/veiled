import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:8080');

ws.on('open', () => {
    console.log('Connected to agent');

    const order = {
        type: "CREATE_DYNAMIC_ORDER",
        order: {
            id: `test-dyn-${Date.now()}`,
            direction: "buy",
            trailingOffset: 10,
            amount: 1,
            currentTarget: 0, // Will be calc by agent
            userAddress: "0x123",
        }
    };

    ws.send(JSON.stringify(order));
    console.log('Sent order:', order);
});

ws.on('message', (data) => {
    console.log('Received:', data.toString());
});

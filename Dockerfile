FROM python:3.12-slim

WORKDIR /app

# Copy the demo script into the container
COPY demo/ ./demo/

# Run the demo script by default when container starts
CMD ["python3", "demo/demo_sandbox.py"]
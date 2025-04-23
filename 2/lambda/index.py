import json
import boto3
import gzip
import base64
import os
from datetime import datetime

s3 = boto3.client('s3')
bucket = os.environ.get('BUCKET_NAME', 'your-bucket-name')

def handler(event, context):
    print("Lambda triggered")
    print("Received event:", json.dumps(event))

    try:
        cw_data = event['awslogs']['data']
        compressed_payload = base64.b64decode(cw_data)
        uncompressed_payload = gzip.decompress(compressed_payload).decode('utf-8')
        logs = json.loads(uncompressed_payload)

        print("Decoded logs:", json.dumps(logs, indent=2))

        # Write logs to S3
        timestamp = datetime.utcnow().strftime('%Y-%m-%d_%H-%M-%S')
        key = f"logs/{logs['logGroup'].replace('/', '_')}_{timestamp}.json"

        s3.put_object(
            Bucket=bucket,
            Key=key,
            Body=json.dumps(logs, indent=2).encode('utf-8')
        )

        return {
            'statusCode': 200,
            'body': 'Log processed and stored in S3'
        }

    except Exception as e:
        print("ERROR:", str(e))
        raise e
